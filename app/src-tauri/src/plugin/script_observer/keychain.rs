//! Extract the app name from a known, static SecurityAgent keychain label.
use crate::macos::accessibility::{ax_application, ax_attribute, ax_window_bounds};
use core_foundation::{
    array::CFArray,
    base::{CFType, CFTypeRef, TCFType},
    string::CFString,
};
use core_graphics::geometry::CGRect;
use std::{collections::VecDeque, time::Instant};

const MAX_ELEMENTS: usize = 28;
const MAX_WINDOWS: usize = 8;

fn app_name(label: &str) -> Option<&str> {
    // Templates from SecurityAgent's keychain-item access dialog. The middle
    // and ending also distinguish it from administrator and unlock dialogs.
    let label = label.trim();
    let templates = [
        (
            " wants to use your confidential information stored in “",
            "” in your keychain.",
        ),
        ("想要使用你存储在钥匙串的“", "”中的机密信息。"),
        ("想要使用你存储在钥匙串中的“", "”中的机密信息。"),
        ("想使用你在鑰匙圈的「", "」裏儲存的機密資料。"),
        ("」想使用你在鑰匙圈的「", "」裡儲存的機密資訊。"),
    ];
    for (middle, end) in templates {
        let Some((name, item)) = label.split_once(middle) else {
            continue;
        };
        if !item
            .strip_suffix(end)
            .is_some_and(|item| !item.trim().is_empty())
        {
            continue;
        }
        let name = name.trim_matches(|c: char| {
            c.is_whitespace() || matches!(c, '“' | '”' | '「' | '」' | '\u{2068}' | '\u{2069}')
        });
        if !name.is_empty() && name.len() <= 120 && !name.chars().any(char::is_control) {
            return Some(name);
        }
    }
    None
}

fn elements(parent: CFTypeRef, attribute: &str, limit: usize) -> Option<Vec<CFType>> {
    let children = ax_attribute(parent, attribute)?.downcast_into::<CFArray>()?;
    if children.len() as usize > limit {
        return None;
    }
    Some(
        children
            .iter()
            .map(|child| unsafe { CFType::wrap_under_get_rule((*child).cast()) })
            .collect(),
    )
}

fn same_bounds(left: CGRect, right: CGRect) -> bool {
    [
        (left.origin.x, right.origin.x),
        (left.origin.y, right.origin.y),
        (left.size.width, right.size.width),
        (left.size.height, right.size.height),
    ]
    .iter()
    .all(|(a, b)| (a - b).abs() <= 2.)
}

pub(super) fn request_app(pid: i32, bounds: CGRect, deadline: Instant) -> Option<String> {
    let app = ax_application(pid, 0.05)?;
    let windows = elements(app.as_CFTypeRef(), "AXWindows", MAX_WINDOWS)?;
    let mut matched = None;
    for window in windows {
        if Instant::now() >= deadline {
            return None;
        }
        let frame = ax_window_bounds(window.as_CFTypeRef())?;
        if same_bounds(frame, bounds) && matched.replace(window).is_some() {
            return None;
        }
    }
    let window = matched?;
    let mut pending = VecDeque::from(elements(window.as_CFTypeRef(), "AXChildren", MAX_ELEMENTS)?);
    let mut seen = 0;
    let mut request = None;
    let mut keychain_action = false;
    while let Some(element) = pending.pop_front() {
        if Instant::now() >= deadline {
            return None;
        }
        seen += 1;
        let element = element.as_CFTypeRef();
        let Some(role) =
            ax_attribute(element, "AXRole").and_then(CFType::downcast_into::<CFString>)
        else {
            continue;
        };
        match role.to_string().as_str() {
            // Editable fields and their descendants never reach this AXValue read.
            "AXStaticText" => {
                let Some(label) =
                    ax_attribute(element, "AXValue").and_then(CFType::downcast_into::<CFString>)
                else {
                    continue;
                };
                if label.char_len() > 1024 {
                    continue;
                }
                if let Some(name) = app_name(&label.to_string()) {
                    if request.as_deref().is_some_and(|existing| existing != name) {
                        return None;
                    }
                    request = Some(name.to_owned());
                }
            }
            "AXButton" => {
                let title =
                    ax_attribute(element, "AXTitle").and_then(CFType::downcast_into::<CFString>);
                keychain_action |= title.is_some_and(|title| {
                    matches!(
                        title.to_string().as_str(),
                        "Always Allow" | "始终允许" | "總是允許" | "永遠允許"
                    )
                });
            }
            "AXGroup" | "AXScrollArea" => {
                let room = MAX_ELEMENTS - seen - pending.len();
                if let Some(children) = elements(element, "AXChildren", room) {
                    pending.extend(children);
                }
            }
            _ => {}
        }
    }
    if keychain_action {
        request
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::app_name;

    #[test]
    fn extracts_the_requesting_app_and_discards_the_item_label() {
        for label in [
            "Arc wants to use your confidential information stored in “Private Item” in your keychain.",
            "Arc想要使用你存储在钥匙串的“Arc Safe Storage”中的机密信息。",
            "「Arc」想使用你在鑰匙圈的「Private Item」裡儲存的機密資訊。",
        ] { assert_eq!(app_name(label), Some("Arc")); }
        assert_eq!(
            app_name("\u{2068}Arc\u{2069}想要使用你存储在钥匙串中的“Example”中的机密信息。"),
            Some("Arc")
        );
        for label in [
            "Password:",
            "Arc wants to make changes.",
            "Arc想要使用你存储在钥匙串的“Example”",
            "Example",
        ] {
            assert_eq!(app_name(label), None);
        }
    }
}
