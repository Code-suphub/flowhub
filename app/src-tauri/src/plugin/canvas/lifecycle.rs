use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub(super) struct Snapshot { pub active:bool, pub revision:u64 }
struct Inner { snapshot:Snapshot, epoch:u64, current:Option<u64> }
pub(super) struct Store(Mutex<Inner>);
impl Default for Store {
    // Until a real native observation exists, preserve work rather than treating
    // uncertainty (or focus loss) as a hidden window.
    fn default()->Self {Self(Mutex::new(Inner{snapshot:Snapshot{active:true,revision:0},epoch:0,current:None}))}
}
impl Store {
    fn begin(&self)->u64 {
        let mut inner=self.0.lock().unwrap();inner.epoch+=1;let epoch=inner.epoch;inner.current=Some(epoch);
        inner.snapshot=Snapshot{active:true,revision:inner.snapshot.revision+1};epoch
    }
    fn epoch(&self)->Option<u64> {self.0.lock().unwrap().current}
    fn snapshot(&self)->Snapshot {self.0.lock().unwrap().snapshot}
    fn observe(&self,epoch:u64,active:Option<bool>)->Option<Snapshot> {
        let mut inner=self.0.lock().unwrap();if inner.current!=Some(epoch){return None;}
        let active=active?;if inner.snapshot.active==active{return None;}
        inner.snapshot=Snapshot{active,revision:inner.snapshot.revision+1};Some(inner.snapshot)
    }
    fn end(&self,epoch:u64)->bool {
        let mut inner=self.0.lock().unwrap();if inner.current!=Some(epoch){return false;}
        inner.current=None;inner.epoch+=1;
        if inner.snapshot.active {inner.snapshot=Snapshot{active:false,revision:inner.snapshot.revision+1};}true
    }
}
fn active(visible:bool,minimized:bool,occlusion_visible:Option<bool>)->bool {visible && !minimized && occlusion_visible.unwrap_or(true)}
fn publish(app:&tauri::AppHandle,snapshot:Snapshot) {
    if let Some(window)=app.get_webview_window("plugin-canvas") {
        let _=window.eval(&format!("window.dispatchEvent(new CustomEvent('flowhub:canvas-lifecycle',{{detail:{}}}))",serde_json::json!(snapshot)));
    }
}

#[cfg(target_os="macos")]
fn actual(window:&tauri::WebviewWindow)->Result<bool,String> {
    let (tx,rx)=std::sync::mpsc::sync_channel(1);
    window.with_webview(move|webview|{
        let result=if objc2::MainThreadMarker::new().is_none(){Err("窗口生命周期只能在主线程读取".into())}else{
            let native=unsafe{&*webview.ns_window().cast::<objc2_app_kit::NSWindow>()};
            Ok(active(native.isVisible(),native.isMiniaturized(),Some(native.occlusionState().contains(objc2_app_kit::NSWindowOcclusionState::Visible))))
        };let _=tx.send(result);
    }).map_err(|e|e.to_string())?;
    rx.recv().map_err(|_|"窗口生命周期读取中断".to_string())?
}
#[cfg(not(target_os="macos"))]
fn actual(window:&tauri::WebviewWindow)->Result<bool,String> {
    // Tauri does not expose an occlusion event on these platforms. Visibility
    // and minimized state remain authoritative; focus is never substituted.
    Ok(active(window.is_visible().map_err(|e|e.to_string())?,window.is_minimized().map_err(|e|e.to_string())?,None))
}
pub(super) fn sample_epoch(app:&tauri::AppHandle,window:&tauri::WebviewWindow,epoch:u64)->Snapshot {
    let state=app.state::<super::State>();
    if state.lifecycle.epoch()!=Some(epoch){return state.lifecycle.snapshot();}
    let observation=actual(window).ok();
    if let Some(snapshot)=state.lifecycle.observe(epoch,observation) {publish(app,snapshot);}
    state.lifecycle.snapshot()
}
pub(super) fn sample(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Snapshot {
    let epoch=app.state::<super::State>().lifecycle.epoch();
    if let Some(epoch)=epoch {sample_epoch(app,window,epoch)}else{app.state::<super::State>().lifecycle.snapshot()}
}
fn can_read(label:&str)->bool {label=="plugin-canvas"}
pub(super) fn read(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<Snapshot,String> {
    if !can_read(window.label()) {return Err("生命周期来源无效".into());}
    let window=window.clone();super::compact::on_main(app,move|app|Ok(sample(app,&window)))
}

#[cfg(target_os="macos")]
struct Observers { epoch:u64, tokens:Vec<objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>> }
#[cfg(target_os="macos")]
thread_local! {static OBSERVERS:std::cell::RefCell<Option<Observers>>=const {std::cell::RefCell::new(None)};}
#[cfg(target_os="macos")]
fn remove_observers(epoch:Option<u64>) {
    OBSERVERS.with(|observers|{
        let old={let mut current=observers.borrow_mut();if epoch.is_some() && current.as_ref().map(|s|s.epoch)!=epoch{return;}current.take()};
        if let Some(old)=old {
            let center=objc2_foundation::NSNotificationCenter::defaultCenter();
            for observer in old.tokens {unsafe{center.removeObserver(AsRef::<objc2::runtime::AnyObject>::as_ref(&*observer));}}
        }
    });
}
pub(super) fn install(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->Result<u64,String> {
    let epoch=app.state::<super::State>().lifecycle.begin();
    #[cfg(target_os="macos")]
    {
        let (tx,rx)=std::sync::mpsc::sync_channel(1);let handle=app.clone();
        let registered=window.with_webview(move|webview|{
            let result=(||->Result<(),String>{
                if objc2::MainThreadMarker::new().is_none(){return Err("窗口监听只能在主线程注册".into());}
                remove_observers(None);
                let native=unsafe{&*webview.ns_window().cast::<objc2_app_kit::NSWindow>()};
                let center=objc2_foundation::NSNotificationCenter::defaultCenter();
                let app=handle.clone();
                let callback=block2::RcBlock::new(move|_:std::ptr::NonNull<objc2_foundation::NSNotification>|{
                    // Notifications use the main queue and hold no native window
                    // pointer. Old-session blocks cannot touch a replacement.
                    if app.state::<super::State>().lifecycle.epoch()!=Some(epoch){return;}
                    if let Some(window)=app.get_webview_window("plugin-canvas"){sample_epoch(&app,&window,epoch);}
                });
                let names=unsafe{[objc2_app_kit::NSWindowDidChangeOcclusionStateNotification,objc2_app_kit::NSWindowDidMiniaturizeNotification,objc2_app_kit::NSWindowDidDeminiaturizeNotification]};
                let mut tokens=vec![];
                for name in names {tokens.push(unsafe{center.addObserverForName_object_queue_usingBlock(Some(name),Some(AsRef::<objc2::runtime::AnyObject>::as_ref(native)),Some(&objc2_foundation::NSOperationQueue::mainQueue()),&callback)});}
                OBSERVERS.with(|observers|*observers.borrow_mut()=Some(Observers{epoch,tokens}));Ok(())
            })();let _=tx.send(result);
        }).map_err(|e|e.to_string());
        let result=registered.and_then(|_|rx.recv().map_err(|_|"窗口监听注册中断".to_string())?);
        if let Err(error)=result {destroy(app,epoch);return Err(error);}
    }
    sample_epoch(app,window,epoch);
    #[cfg(not(target_os="macos"))]
    start_sampler(app.clone(),epoch);
    Ok(epoch)
}
pub(super) fn destroy(app:&tauri::AppHandle,epoch:u64) {
    // Invalidate first; a queued main-queue observer can still be delivered after
    // removeObserver, but its captured epoch is already harmless.
    let ended=app.state::<super::State>().lifecycle.end(epoch);
    #[cfg(target_os="macos")]
    if ended {remove_observers(Some(epoch));}
    #[cfg(not(target_os="macos"))]
    let _=ended;
}

#[cfg(any(not(target_os="macos"),test))]
async fn sampler_loop<F:std::future::Future<Output=bool>>(mut current:impl FnMut()->bool,mut sample:impl FnMut()->F) {
    while current() {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if !current() || !sample().await {return;}
        // The next interval starts only after the previous UI-thread sample has
        // completed. Minimized windows cannot accumulate queued sampling work.
    }
}
#[cfg(not(target_os="macos"))]
fn start_sampler(app:tauri::AppHandle,epoch:u64) {
    let live_app=app.clone();
    tauri::async_runtime::spawn(sampler_loop(move||live_app.state::<super::State>().lifecycle.epoch()==Some(epoch),move||{
        let app=app.clone();async move {
            let (tx,rx)=tokio::sync::oneshot::channel();let handle=app.clone();
            if app.run_on_main_thread(move||{
                if handle.state::<super::State>().lifecycle.epoch()!=Some(epoch){let _=tx.send(false);return;}
                let Some(window)=handle.get_webview_window("plugin-canvas") else{let _=tx.send(false);return;};
                sample_epoch(&handle,&window,epoch);let _=tx.send(true);
            }).is_err(){return false;}
            rx.await.unwrap_or(false)
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_visibility_and_occlusion_control_activity_without_focus() {
        assert!(active(true,false,Some(true)),"visible unfocused windows remain active; focus is not an input");
        assert!(!active(false,false,Some(true)));assert!(!active(true,true,Some(true)));assert!(!active(true,false,Some(false)));
        assert!(active(true,false,None),"platforms without occlusion use real visibility/minimized state");
        assert!(can_read("plugin-canvas"));for label in ["settings","widget-detail-1","plugin-machines","other"] {assert!(!can_read(label));}
    }
    #[test]
    fn snapshots_and_events_share_a_monotonic_revision_and_unknown_is_conservative() {
        let store=Store::default();assert!(store.snapshot().active);
        let epoch=store.begin();let initial=store.snapshot();assert!(initial.revision>0);
        assert!(store.observe(epoch,None).is_none());assert_eq!(store.snapshot(),initial);
        let hidden=store.observe(epoch,Some(false)).unwrap();assert!(hidden.revision>initial.revision);assert_eq!(store.snapshot(),hidden);
        assert!(store.observe(epoch,Some(false)).is_none());assert_eq!(store.snapshot(),hidden);
        let visible=store.observe(epoch,Some(true)).unwrap();assert!(visible.revision>hidden.revision);assert_eq!(store.snapshot(),visible);
    }
    #[test]
    fn destroyed_or_replaced_window_callbacks_cannot_publish_or_stop_new_window() {
        let store=Store::default();let old=store.begin();store.observe(old,Some(false));assert!(store.end(old));
        let revision=store.snapshot().revision;assert!(store.observe(old,Some(true)).is_none());assert_eq!(store.snapshot().revision,revision);
        let new=store.begin();assert_ne!(old,new);let current=store.snapshot();assert!(current.revision>revision);
        assert!(!store.end(old));assert!(store.observe(old,Some(false)).is_none());assert_eq!(store.snapshot(),current);
        let hidden=store.observe(new,Some(false)).unwrap();assert!(hidden.revision>current.revision);assert!(store.end(new));assert!(!store.end(new));
    }
    #[tokio::test(start_paused=true)]
    async fn fallback_sampler_waits_for_the_previous_ui_sample_and_stops_after_session_end() {
        use std::sync::{Arc,atomic::{AtomicBool,AtomicUsize,Ordering}};
        let live=Arc::new(AtomicBool::new(true));let calls=Arc::new(AtomicUsize::new(0));let (tx,rx)=tokio::sync::oneshot::channel();let mut pending=Some(rx);
        let live_read=live.clone();let sampled=calls.clone();
        let task=tokio::spawn(sampler_loop(move||live_read.load(Ordering::SeqCst),move||{
            let pending=pending.take();let calls=sampled.clone();async move {
                calls.fetch_add(1,Ordering::SeqCst);if let Some(pending)=pending {let _=pending.await;}true
            }
        }));
        tokio::task::yield_now().await;tokio::time::advance(std::time::Duration::from_secs(1)).await;tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst),1);
        tokio::time::advance(std::time::Duration::from_secs(20)).await;tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst),1,"one blocked UI sample must not produce a polling backlog");
        live.store(false,Ordering::SeqCst);let _=tx.send(());task.await.unwrap();
        tokio::time::advance(std::time::Duration::from_secs(20)).await;assert_eq!(calls.load(Ordering::SeqCst),1);
    }
    #[tokio::test(start_paused=true)]
    async fn fallback_sampler_cannot_query_a_window_destroyed_before_its_first_tick() {
        use std::sync::{Arc,atomic::{AtomicBool,AtomicUsize,Ordering}};
        let live=Arc::new(AtomicBool::new(true));let calls=Arc::new(AtomicUsize::new(0));let l=live.clone();let c=calls.clone();
        let task=tokio::spawn(sampler_loop(move||l.load(Ordering::SeqCst),move||{let c=c.clone();async move {c.fetch_add(1,Ordering::SeqCst);true}}));
        tokio::task::yield_now().await;live.store(false,Ordering::SeqCst);
        tokio::time::advance(std::time::Duration::from_secs(1)).await;task.await.unwrap();assert_eq!(calls.load(Ordering::SeqCst),0);
    }
}
