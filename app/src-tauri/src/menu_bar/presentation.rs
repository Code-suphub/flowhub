//! Human-readable menu item names, without window-system placeholders.

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
