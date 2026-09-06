//! Restart-safe section memory. Window IDs and PIDs are deliberately never keys.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::ErrorKind,
    path::Path,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Section {
    Visible,
    Hidden,
    AlwaysHidden,
}

pub struct Identity {
    pub owner: String,
    pub title: String,
    pub accessibility_id: String,
    pub stable_id: String,
}

impl Identity {
    fn key(&self) -> String {
        // JSON tuple encoding avoids separator collisions in the existing stable_id.
        serde_json::to_string(&(&self.owner, &self.title, &self.accessibility_id)).unwrap()
    }

    fn usable(&self) -> bool {
        // Most third-party icons expose only an owner and stable ID. Inventory
        // uniqueness and persisted collision tombstones guard those identities too.
        !self.owner.trim().is_empty() && !self.stable_id.is_empty()
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Memory {
    originals: BTreeMap<String, Section>,
    #[serde(default)]
    orders: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    section_orders: BTreeMap<String, Vec<String>>,
    // Once ambiguity is observed, do not reuse an old record when only one of
    // the colliding icons remains in a later inventory or after restart.
    ambiguous: BTreeSet<String>,
}

pub struct Plan {
    pub destination: Section,
    pub fallback_reason: Option<&'static str>,
}

impl Plan {
    pub fn target(&self, control: u32, always: u32) -> (u32, bool) {
        match self.destination {
            Section::AlwaysHidden => (always, true),
            Section::Hidden => (always, false),
            Section::Visible => (control, false),
        }
    }
}

impl Memory {
    /// `ordered` contains unique, manageable icons in physical left-to-right
    /// order in the original section. Retain hidden placeholders so hiding
    /// several adjacent icons also works when restored in a different order.
    pub fn remember_order(&mut self, item: &Identity, section: Section, ordered: &[&Identity]) {
        let key = item.key();
        if !item.usable() || self.ambiguous.contains(&key) || section == Section::AlwaysHidden { return; }
        let current: Vec<_> = ordered.iter().filter(|i| i.usable() && !self.ambiguous.contains(&i.key())).map(|i| i.key()).collect();
        let section_key = format!("{section:?}");
        let previous = self.section_orders.entry(section_key).or_default();
        let live: BTreeSet<_> = current.iter().cloned().collect();
        // Keep absent icons only if they are known to belong to this section.
        previous.retain(|k| live.contains(k) || self.originals.get(k) == Some(&section));
        let mut pending = current.iter();
        let mut merged = Vec::new();
        for old in previous.iter() {
            if live.contains(old) {
                if let Some(next) = pending.next() { merged.push(next.clone()); }
            } else { merged.push(old.clone()); }
        }
        merged.extend(pending.cloned());
        // Initially there are no slots; current order becomes the baseline.
        *previous = merged.clone();
        self.orders.insert(key, merged);
    }

    /// Return a current inventory index and the side of that surviving anchor.
    /// Only anchors still in the destination section may be used.
    pub fn order_anchor(&self, item: &Identity, destination: Section, current: &[(&Identity, Section)]) -> Option<(usize, bool)> {
        if !item.usable() || self.ambiguous.contains(&item.key()) { return None; }
        let order = self.orders.get(&item.key())?;
        let position = order.iter().position(|k| *k == item.key())?;
        let find = |key: &String| {
            if self.ambiguous.contains(key) { return None; }
            let matches: Vec<_> = current.iter().enumerate().filter(|(_, (i,s))| i.key() == *key && *s == destination).collect();
            (matches.len() == 1).then(|| matches[0].0)
        };
        // Prefer inserting before the nearest surviving right neighbour.
        for key in &order[position + 1..] { if let Some(i) = find(key) { return Some((i, true)); } }
        for key in order[..position].iter().rev() { if let Some(i) = find(key) { return Some((i, false)); } }
        None
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        match fs::read(path) {
            Ok(bytes) => {
                let memory: Self = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Invalid section memory: {e}"))?;
                if memory
                    .originals
                    .values()
                    .any(|s| *s == Section::AlwaysHidden)
                {
                    return Err("Invalid original section in section memory".into());
                }
                Ok(memory)
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("Cannot read section memory: {e}")),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        super::write_json_atomic(
            path,
            &serde_json::to_value(self).map_err(|e| e.to_string())?,
        )
    }

    pub fn prepare(
        &mut self,
        items: &[Identity],
        index: usize,
        current: Section,
        hide: bool,
    ) -> Plan {
        let mut stable_counts = BTreeMap::new();
        let mut key_counts = BTreeMap::new();
        for item in items {
            *stable_counts.entry(&item.stable_id).or_insert(0) += 1;
            *key_counts.entry(item.key()).or_insert(0) += 1;
        }
        for item in items {
            if stable_counts[&item.stable_id] > 1 || key_counts[&item.key()] > 1 {
                self.ambiguous.insert(item.key());
            }
        }
        let item = &items[index];
        let key = item.key();
        let reason = if !item.usable() {
            Some("insufficient_identity")
        } else if self.ambiguous.contains(&key) {
            Some("ambiguous_identity")
        } else {
            None
        };
        if hide {
            if reason.is_none() && current != Section::AlwaysHidden {
                self.originals.insert(key, current);
            }
            return Plan {
                destination: Section::AlwaysHidden,
                fallback_reason: reason,
            };
        }
        // An already-enabled icon needs no historical record to retain its section.
        if current != Section::AlwaysHidden {
            return Plan {
                destination: current,
                fallback_reason: None,
            };
        }
        let original = reason
            .is_none()
            .then(|| self.originals.get(&key).copied())
            .flatten();
        Plan {
            destination: original.unwrap_or(Section::Visible),
            fallback_reason: reason.or_else(|| original.is_none().then_some("no_original_section")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn middle_icon_restores_before_right_or_after_left_neighbour() {
        let items = [icon("A"), icon("B"), icon("C")];
        let mut memory = Memory::default();
        memory.prepare(&items, 1, Section::Hidden, true);
        memory.remember_order(&items[1], Section::Hidden, &items.iter().collect::<Vec<_>>());
        let mut restarted: Memory = serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
        let current = [(&items[0], Section::Hidden), (&items[1], Section::AlwaysHidden), (&items[2], Section::Hidden)];
        assert_eq!(restarted.order_anchor(&items[1], Section::Hidden, &current), Some((2, true)));
        assert_eq!(restarted.order_anchor(&items[1], Section::Hidden, &current[..2]), Some((0, false)));
        assert_eq!(restarted.order_anchor(&items[1], Section::Hidden, &[(&items[0], Section::Visible)]), None);
        // Repeated hide must not replace the recorded order with hidden-zone order.
        restarted.remember_order(&items[1], Section::AlwaysHidden, &[&items[1]]);
        assert_eq!(restarted.order_anchor(&items[1], Section::Hidden, &current), Some((2, true)));
    }

    #[test]
    fn multiple_hidden_icons_restore_in_any_sequence() {
        for restore in [[0,1,2], [2,1,0], [1,0,2]] {
            let items = [icon("A"), icon("B"), icon("C")];
            let mut memory = Memory::default();
            for hidden in 0..3 {
                memory.prepare(&items, hidden, Section::Hidden, true);
                memory.remember_order(&items[hidden], Section::Hidden, &items[hidden..].iter().collect::<Vec<_>>());
            }
            let mut visible: Vec<usize> = Vec::new();
            for item in restore {
                let current: Vec<_> = visible.iter().map(|i| (&items[*i], Section::Hidden)).collect();
                let insertion = memory.order_anchor(&items[item], Section::Hidden, &current)
                    .map(|(i,left)| i + usize::from(!left)).unwrap_or(0);
                visible.insert(insertion, item);
            }
            assert_eq!(visible, vec![0,1,2]);
        }
    }

    #[test]
    fn legacy_section_memory_loads_without_order_history() {
        let memory: Memory = serde_json::from_str(r#"{"originals":{},"ambiguous":[]}"#).unwrap();
        assert!(memory.orders.is_empty());
        assert!(memory.section_orders.is_empty());
    }

    fn icon(title: &str) -> Identity {
        Identity {
            owner: "App".into(),
            title: title.into(),
            accessibility_id: String::new(),
            stable_id: format!("App\u{1f}{title}"),
        }
    }

    #[test]
    fn restore_both_sections_and_target_sides_after_restart() {
        for section in [Section::Hidden, Section::Visible] {
            let mut memory = Memory::default();
            assert_eq!(
                memory
                    .prepare(&[icon("A")], 0, section, true)
                    .target(10, 20),
                (20, true)
            );
            let bytes = serde_json::to_vec(&memory).unwrap();
            let mut restarted: Memory = serde_json::from_slice(&bytes).unwrap();
            let plan = restarted.prepare(&[icon("A")], 0, Section::AlwaysHidden, false);
            assert_eq!(plan.destination, section);
            assert_eq!(
                plan.target(10, 20),
                (if section == Section::Hidden { 20 } else { 10 }, false)
            );
            assert!(plan.fallback_reason.is_none());
        }
    }

    #[test]
    fn repeated_hide_and_failed_moves_preserve_original() {
        let mut memory = Memory::default();
        memory.prepare(&[icon("A")], 0, Section::Hidden, true);
        // Failed hide still in its original section, then partial/successful hide.
        memory.prepare(&[icon("A")], 0, Section::Hidden, true);
        memory.prepare(&[icon("A")], 0, Section::AlwaysHidden, true);
        for _ in 0..2 {
            // A failed restore can be retried without consuming memory.
            assert_eq!(
                memory
                    .prepare(&[icon("A")], 0, Section::AlwaysHidden, false)
                    .destination,
                Section::Hidden
            );
        }
        memory.prepare(&[icon("A")], 0, Section::Visible, true);
        assert_eq!(
            memory
                .prepare(&[icon("A")], 0, Section::AlwaysHidden, false)
                .destination,
            Section::Visible
        );
    }

    #[test]
    fn collisions_remain_untrusted_after_restart_and_disappearance() {
        let mut memory = Memory::default();
        memory.prepare(&[icon("A")], 0, Section::Hidden, true);
        let mut other = icon("B");
        other.stable_id = icon("A").stable_id;
        let plan = memory.prepare(&[icon("A"), other], 0, Section::AlwaysHidden, false);
        assert_eq!(plan.fallback_reason, Some("ambiguous_identity"));
        let mut memory: Memory =
            serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
        assert_eq!(
            memory
                .prepare(&[icon("A")], 0, Section::AlwaysHidden, false)
                .destination,
            Section::Visible
        );
        assert_eq!(
            memory
                .prepare(&[icon("C"), icon("C")], 0, Section::Hidden, true)
                .fallback_reason,
            Some("ambiguous_identity")
        );
    }

    #[test]
    fn unique_owner_only_identity_restores_after_restart() {
        for section in [Section::Hidden, Section::Visible] {
            let mut memory = Memory::default();
            let plan = memory.prepare(&[icon("")], 0, section, true);
            assert!(plan.fallback_reason.is_none());
            let mut restarted: Memory =
                serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
            let plan = restarted.prepare(&[icon("")], 0, Section::AlwaysHidden, false);
            assert_eq!(plan.destination, section);
            assert!(plan.fallback_reason.is_none());
        }
    }

    #[test]
    fn duplicate_owner_only_identity_stays_ambiguous_after_restart() {
        let mut memory = Memory::default();
        memory.prepare(&[icon("")], 0, Section::Hidden, true);
        for index in 0..2 {
            let plan = memory.prepare(&[icon(""), icon("")], index, Section::AlwaysHidden, false);
            assert_eq!(plan.destination, Section::Visible);
            assert_eq!(plan.fallback_reason, Some("ambiguous_identity"));
        }
        let mut restarted: Memory =
            serde_json::from_slice(&serde_json::to_vec(&memory).unwrap()).unwrap();
        // A sole remaining icon must not inherit the previously saved record.
        let plan = restarted.prepare(&[icon("")], 0, Section::AlwaysHidden, false);
        assert_eq!(plan.destination, Section::Visible);
        assert_eq!(plan.fallback_reason, Some("ambiguous_identity"));
        assert_eq!(
            restarted
                .prepare(&[icon("")], 0, Section::Hidden, true)
                .fallback_reason,
            Some("ambiguous_identity")
        );
    }

    #[test]
    fn unknown_and_incomplete_identities_fall_back_without_inventing_history() {
        let mut memory = Memory::default();
        memory.prepare(&[icon("old")], 0, Section::AlwaysHidden, true);
        let plan = memory.prepare(&[icon("old")], 0, Section::AlwaysHidden, false);
        assert_eq!(plan.destination, Section::Visible);
        assert_eq!(plan.fallback_reason, Some("no_original_section"));
        let mut missing_owner = icon("");
        missing_owner.owner.clear();
        let mut missing_stable_id = icon("");
        missing_stable_id.stable_id.clear();
        for item in [missing_owner, missing_stable_id] {
            let items = [item];
            memory.prepare(&items, 0, Section::Hidden, true);
            assert_eq!(
                memory
                    .prepare(&items, 0, Section::AlwaysHidden, false)
                    .fallback_reason,
                Some("insufficient_identity")
            );
        }
    }

    #[test]
    fn records_are_per_icon_and_do_not_depend_on_inventory_order() {
        let mut memory = Memory::default();
        memory.prepare(&[icon("A"), icon("B")], 0, Section::Hidden, true);
        memory.prepare(&[icon("A"), icon("B")], 1, Section::Visible, true);
        assert_eq!(
            memory
                .prepare(&[icon("B"), icon("A")], 1, Section::AlwaysHidden, false)
                .destination,
            Section::Hidden
        );
        assert_eq!(
            memory
                .prepare(&[icon("B"), icon("A")], 0, Section::AlwaysHidden, false)
                .destination,
            Section::Visible
        );
        let mut changed = icon("A");
        changed.owner = "Other App".into();
        assert_eq!(
            memory
                .prepare(&[changed], 0, Section::AlwaysHidden, false)
                .fallback_reason,
            Some("no_original_section")
        );
    }

    #[test]
    fn persistence_round_trip_and_corrupt_file_is_not_reset() {
        let path = std::env::temp_dir()
            .join(format!(
                "flowhub-section-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join("memory.json");
        let mut memory = Memory::load(&path).unwrap();
        memory.prepare(&[icon("A")], 0, Section::Hidden, true);
        memory.save(&path).unwrap();
        assert_eq!(
            Memory::load(&path)
                .unwrap()
                .prepare(&[icon("A")], 0, Section::AlwaysHidden, false)
                .destination,
            Section::Hidden
        );
        fs::write(&path, b"broken").unwrap();
        assert!(Memory::load(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        assert!(memory.save(&path.join("impossible.json")).is_err());
        fs::remove_file(&path).unwrap();
        fs::remove_dir(path.parent().unwrap()).unwrap();
    }
}
