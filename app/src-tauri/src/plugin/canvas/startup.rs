//! Bounded startup recovery; explicit user actions invalidate pending attempts.
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub(super) struct Recovery(AtomicU64);
impl Recovery {
    pub fn start(&self) -> u64 { self.0.fetch_add(1, Ordering::AcqRel) + 1 }
    pub fn cancel(&self) { self.0.fetch_add(1, Ordering::AcqRel); }
    pub fn current(&self, ticket:u64, enabled:bool) -> bool {
        enabled && self.0.load(Ordering::Acquire) == ticket
    }
}
pub(super) enum Attempt { Ready, Cancelled, Failed }
#[derive(Debug, PartialEq)]
pub(super) enum Outcome { Ready, Cancelled, Exhausted }

pub(super) async fn recover<F, Fut>(mut attempt:F) -> Outcome
where F:FnMut(u32)->Fut, Fut:std::future::Future<Output=Attempt> {
    for (index, delay) in [0, 300, 1000, 2500].into_iter().enumerate() {
        if delay > 0 { tokio::time::sleep(std::time::Duration::from_millis(delay)).await; }
        match attempt(index as u32 + 1).await {
            Attempt::Ready => return Outcome::Ready,
            Attempt::Cancelled => return Outcome::Cancelled,
            Attempt::Failed => (),
        }
    }
    Outcome::Exhausted
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused=true)]
    async fn temporary_display_failures_retry_then_stop_after_success() {
        let mut calls=0;
        let result=recover(|attempt|{calls+=1;std::future::ready(if attempt<3{Attempt::Failed}else{Attempt::Ready})}).await;
        assert_eq!(result,Outcome::Ready);assert_eq!(calls,3);
    }
    #[tokio::test(start_paused=true)]
    async fn persistent_failures_are_bounded_instead_of_reopening_forever() {
        let mut calls=0;let started=tokio::time::Instant::now();
        let result=recover(|_|{calls+=1;std::future::ready(Attempt::Failed)}).await;
        assert_eq!(result,Outcome::Exhausted);assert_eq!(calls,4);
        assert_eq!(started.elapsed(),std::time::Duration::from_millis(3800));
    }
    #[tokio::test(start_paused=true)]
    async fn user_hide_or_open_cancels_recovery_before_another_window_operation() {
        let recovery=Recovery::default();let ticket=recovery.start();let mut operations=0;
        let result=recover(|_|{
            if !recovery.current(ticket,true){return std::future::ready(Attempt::Cancelled);}
            operations+=1;recovery.cancel();std::future::ready(Attempt::Failed)
        }).await;
        assert_eq!(result,Outcome::Cancelled);assert_eq!(operations,1);
    }
    #[test]
    fn disabled_desktop_and_stale_startups_cannot_restore_a_window() {
        let recovery=Recovery::default();let old=recovery.start();assert!(!recovery.current(old,false));
        let next=recovery.start();assert!(!recovery.current(old,true));assert!(recovery.current(next,true));
        recovery.cancel();assert!(!recovery.current(next,true));
    }
}
