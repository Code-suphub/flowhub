use std::time::{Duration, Instant};

pub struct Visibility {
    generation: u64,
    shown_at: Option<Instant>,
}
pub struct BlurCheck {
    pub generation: u64,
    pub delay: Duration,
}
impl Visibility {
    pub const fn new() -> Self {
        Self {
            generation: 0,
            shown_at: None,
        }
    }
    pub fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
    }
    pub fn show(&mut self, now: Instant) {
        self.invalidate();
        self.shown_at = Some(now);
    }
    pub fn blur(&mut self, now: Instant) -> BlurCheck {
        self.invalidate();
        let grace = self
            .shown_at
            .map(|at| Duration::from_millis(500).saturating_sub(now.saturating_duration_since(at)))
            .unwrap_or_default();
        BlurCheck {
            generation: self.generation,
            delay: grace.max(Duration::from_millis(120)),
        }
    }
    pub fn should_hide(
        &self,
        check: &BlurCheck,
        visible: bool,
        focused: bool,
        pinned: bool,
    ) -> bool {
        self.generation == check.generation && visible && !focused && !pinned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_real_blur_is_rechecked_after_show_grace() {
        let mut v = Visibility::new();
        let now = Instant::now();
        v.show(now);
        let check = v.blur(now + Duration::from_millis(80));
        assert_eq!(check.delay, Duration::from_millis(420));
        assert!(v.should_hide(&check, true, false, false));
        assert!(!v.should_hide(&check, true, true, false));
        assert!(!v.should_hide(&check, true, false, true));
    }
    #[test]
    fn refocus_and_new_hotkey_show_cancel_old_blur() {
        let mut v = Visibility::new();
        let now = Instant::now();
        v.show(now);
        let transient = v.blur(now);
        v.invalidate();
        assert!(!v.should_hide(&transient, true, false, false));
        let old = v.blur(now + Duration::from_secs(1));
        v.show(now + Duration::from_secs(2));
        assert!(!v.should_hide(&old, true, false, false));
        let current = v.blur(now + Duration::from_secs(3));
        assert_eq!(current.delay, Duration::from_millis(120));
        assert!(v.should_hide(&current, true, false, false));
    }
    #[test]
    fn missing_focus_event_does_not_disable_future_blur_checks() {
        let mut v = Visibility::new();
        let now = Instant::now();
        let check = v.blur(now);
        assert!(!v.should_hide(&check, false, false, false));
        v.show(now);
        let first = v.blur(now);
        let latest = v.blur(now + Duration::from_millis(100));
        assert!(!v.should_hide(&first, true, false, false));
        assert!(v.should_hide(&latest, true, false, false));
    }
}
