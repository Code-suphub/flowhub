//! Menu list order is independent of physical placement in the three sections.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

#[derive(Default, Deserialize, Serialize)]
pub struct Order(Vec<String>);
impl Order {
    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::metadata(path) {
            Ok(meta) if !meta.is_file() || meta.len() > 256 * 1024 => {
                return Err("菜单栏列表顺序文件无效".into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default())
            }
            Err(error) => return Err(error.to_string()),
            _ => (),
        }
        let value: Self = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|_| "菜单栏列表顺序文件损坏")?;
        if value.0.len() > 512 || value.0.iter().any(|key| key.len() > 1024) {
            return Err("菜单栏列表顺序超限".into());
        }
        Ok(value)
    }
    pub fn arrange(&mut self, keys: &[String]) -> Vec<usize> {
        let live: BTreeSet<_> = keys.iter().cloned().collect();
        for key in keys {
            if key.len() <= 1024 && !self.0.contains(key) {
                self.0.push(key.clone());
            }
        }
        // Retain slots for temporarily absent apps, bounded independently of PIDs.
        while self.0.len() > 512 {
            let index = self
                .0
                .iter()
                .position(|key| !live.contains(key))
                .unwrap_or(0);
            self.0.remove(index);
        }
        let mut indices = (0..keys.len()).collect::<Vec<_>>();
        indices.sort_by_key(|i| {
            self.0
                .iter()
                .position(|key| key == &keys[*i])
                .unwrap_or(usize::MAX)
        });
        indices
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        crate::storage::write_json_atomic(
            path,
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }
}

pub fn placeholder_title(title: &str) -> bool {
    let value = title.trim().to_ascii_lowercase();
    value.is_empty()
        || value
            .strip_prefix("item-")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()))
        || matches!(value.as_str(), "nsstatusitem" | "statusitem" | "(null)")
}

pub fn display_name(title: &str, label: &str, owner: &str) -> String {
    let known = match title {
        "Clock" => Some("时钟"),
        "BentoBox" => Some("控制中心"),
        "WiFi" => Some("无线局域网"),
        "Bluetooth" => Some("蓝牙"),
        "Battery" => Some("电池"),
        "FocusModes" => Some("专注模式"),
        "Sound" => Some("声音"),
        _ => None,
    };
    if let Some(name) = known {
        return name.into();
    }
    [title, label, owner]
        .into_iter()
        .find(|name| !placeholder_title(name))
        .unwrap_or("未命名图标")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reopening_with_moved_icons_preserves_list_order_and_reappearing_app_slots() {
        let mut order = Order::default();
        let keys = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(order.arrange(&keys(&["A", "Magpie", "B"])), vec![0, 1, 2]);
        let mut restarted: Order =
            serde_json::from_slice(&serde_json::to_vec(&order).unwrap()).unwrap();
        assert_eq!(
            restarted.arrange(&keys(&["Magpie", "B", "A"])),
            vec![2, 0, 1]
        );
        assert_eq!(restarted.arrange(&keys(&["B", "A", "new"])), vec![1, 0, 2]);
        assert_eq!(
            restarted.arrange(&keys(&["new", "Magpie", "A", "B"])),
            vec![2, 1, 3, 0]
        );
    }
    #[test]
    fn window_placeholders_do_not_override_meaningful_names() {
        for title in ["Item-0", "item-12", "NSStatusItem", "", "(null)"] {
            assert!(placeholder_title(title));
        }
        for title in ["Magpie", "Battery", "Item-manager", "Item-0 Report"] {
            assert!(!placeholder_title(title));
        }
        assert_eq!(display_name("Item-0", "", "Magpie"), "Magpie");
        assert_eq!(display_name("item-12", "Item-0", "ChatGPT"), "ChatGPT");
        assert_eq!(display_name("Item-0", "输入法", "SystemUIServer"), "输入法");
        assert_eq!(display_name("Battery", "Battery", "Control Center"), "电池");
        assert_eq!(display_name("", "", ""), "未命名图标");
    }
}
