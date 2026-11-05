use tauri_plugin_global_shortcut::Shortcut;

// Web KeyboardEvent calls Command/Windows "Meta". Older settings persisted
// that spelling, although the native parser accepts Command/Cmd/Super instead.
pub(crate) fn parse(value: &str) -> Result<Shortcut, String> {
    let normalized = value.split('+').map(|part| {
        let part = part.trim();
        if part.eq_ignore_ascii_case("meta") || part.eq_ignore_ascii_case("os") {
            "Super"
        } else { part }
    }).collect::<Vec<_>>().join("+");
    normalized.parse::<Shortcut>().map_err(|_| "快捷键格式不支持，请点击快捷键后重新录入".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_meta_and_command_aliases_register_the_same_key() {
        let expected = parse("Command+Space").unwrap();
        for value in ["Meta+Space", " meta + Space ", "META+Space", "OS+Space", "Cmd+Space", "Super+Space"] {
            assert_eq!(parse(value).unwrap(), expected, "{value}");
        }
    }
    #[test]
    fn compatibility_keeps_other_modifiers_and_distinct_physical_keys() {
        assert_eq!(parse("Ctrl+Alt+Shift+Meta+K").unwrap(), parse("Control+Option+Shift+Command+KeyK").unwrap());
        assert_ne!(parse("Command+Numpad1").unwrap(), parse("Command+1").unwrap());
        for value in ["Command+Equal", "Alt+Semicolon", "Shift+NumpadAdd", "Ctrl+Escape", "Meta+Backspace"] {
            assert!(parse(value).is_ok(), "{value}");
        }
    }
    #[test]
    fn malformed_or_unrecognizable_shortcuts_never_fall_back_to_a_different_key() {
        for value in ["Meta", "Meta++Space", "Meta+Dead", "Meta+Process", "Alt+˚", "Ctrl+K+Shift"] {
            assert!(parse(value).is_err(), "{value}");
        }
    }
}
