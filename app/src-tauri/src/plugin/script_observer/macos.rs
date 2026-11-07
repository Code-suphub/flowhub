use super::{Identity,Node,Script,Source,Window};
use core_foundation::{array::CFArray,base::{CFType,TCFType},dictionary::CFDictionary,number::CFNumber,string::{CFString,CFStringRef}};
use core_graphics::window::{CGWindowListCopyWindowInfo,kCGNullWindowID,kCGWindowListOptionOnScreenOnly,kCGWindowListExcludeDesktopElements,kCGWindowOwnerPID,kCGWindowNumber,kCGWindowBounds,kCGWindowAlpha};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSScreen, NSWindow};
use objc2_foundation::NSPoint;
use sha2::{Digest,Sha256};
use std::{collections::HashSet,mem::{size_of,zeroed},time::{Duration,Instant}};

fn process(pid:i32)->Option<(Identity,i32)>{
    let mut bsd:libc::proc_bsdinfo=unsafe{zeroed()};
    if pid<=1||unsafe{libc::proc_pidinfo(pid,libc::PROC_PIDTBSDINFO,0,(&mut bsd as *mut libc::proc_bsdinfo).cast(),size_of::<libc::proc_bsdinfo>() as i32)}!=size_of::<libc::proc_bsdinfo>() as i32||bsd.pbi_status==libc::SZOMB{return None;}
    let mut bytes=[0u8;4096];let n=unsafe{libc::proc_pidpath(pid,bytes.as_mut_ptr().cast(),bytes.len() as u32)};
    if n<=0{return None;}let len=bytes.iter().position(|b|*b==0).unwrap_or(bytes.len());
    let executable=String::from_utf8(bytes[..len].to_vec()).ok()?;
    Some((Identity{pid,uid:bsd.pbi_uid,started:bsd.pbi_start_tvsec.saturating_mul(1_000_000)+bsd.pbi_start_tvusec,executable},bsd.pbi_ppid as i32))
}
fn node(identity:Identity)->Node{
    let app_path=identity.executable.find(".app/").map(|end|identity.executable[..end+4].to_string());
    let name=identity.executable.rsplit('/').next().unwrap_or("进程").to_string();Node{identity,name,app_path}
}
fn script(identity:Identity,mut parent:i32,at:u64)->Option<Script>{
    let mut chain=vec![node(identity.clone())];let mut visited=HashSet::from([identity.pid]);let mut note=String::new();
    while parent>1&&chain.len()<16&&chain.last()?.app_path.is_none(){
        let Some((id,next))=process(parent) else{note="部分父进程不可读取，启动链不完整。".into();break;};
        let current=&chain.last()?.identity;
        if id.uid!=identity.uid||id.started==0||id.started>current.started||!visited.insert(id.pid)||process(current.pid)?.1!=id.pid{note="父链身份或用户边界无法核验，已停止追溯。".into();break;}
        chain.push(node(id));parent=next;
    }
    if chain.len()==16{note="启动链已达到 16 层上限。".into();}
    if parent<=1&&chain.last()?.app_path.is_none(){note="父链到达 launchd，更早的来源不可追溯。".into();}
    if process(identity.pid)?.0!=identity||chain.iter().any(|n|process(n.identity.pid).as_ref().map(|p|&p.0)!=Some(&n.identity)){return None;}
    let source=chain.iter().find_map(|n|n.app_path.as_ref()).map(|path|Source{name:path.rsplit('/').next().unwrap_or(path).trim_end_matches(".app").into(),app_path:path.clone(),evidence:"已核验脚本当前父进程链；与认证窗口的关系仅为同时段线索".into()});
    chain.reverse();
    Some(Script{id:format!("script-{:x}",Sha256::digest(format!("{}:{}:{}:{}",identity.pid,identity.started,identity.uid,identity.executable))),process:node(identity),chain,source,responsible:None,chain_note:note,first_seen:at,last_seen:at,running:true})
}
fn scripts(at:u64)->Result<Vec<Script>,String>{
    let count=unsafe{libc::proc_listallpids(std::ptr::null_mut(),0)};if count<=0{return Err("脚本进程枚举暂不可用。".into());}
    let mut pids=vec![0i32;(count as usize+256).min(65536)];let size=unsafe{libc::proc_listallpids(pids.as_mut_ptr().cast(),(pids.len()*size_of::<i32>()) as i32)};
    if size<=0{return Err("脚本进程枚举暂不可用。".into());}
    pids.truncate((size as usize).min(pids.len()));let uid=unsafe{libc::geteuid()};let mut result=vec![];let deadline=Instant::now()+Duration::from_millis(300);
    for pid in pids {
        if Instant::now()>=deadline{return Err("脚本观察本轮超过时间预算，保留此前记录。".into());}
        let Some((id,parent))=process(pid)else{continue;};
        if id.uid==uid&&matches!(id.executable.as_str(),"/usr/bin/osascript"|"/usr/bin/automator"){
            if let Some(record)=script(id,parent,at){result.push(record);if result.len()==64{break;}}
        }
    }
    Ok(result)
}
fn value(d:&CFDictionary<CFString,CFType>,key:CFStringRef)->Option<CFType>{let key=unsafe{CFString::wrap_under_get_rule(key)};d.find(&key).map(|v|v.as_CFType())}
fn number(d:&CFDictionary<CFString,CFType>,key:CFStringRef)->Option<i32>{value(d,key)?.downcast::<CFNumber>()?.to_i32()}
fn is_security_agent(path:&str)->bool{
    path.starts_with("/System/Library/Frameworks/Security.framework/Versions/")&&path.ends_with("/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent")
}
fn windows()->Option<Vec<Window>>{
    // Owner PID, window ID, alpha and bounds only. In particular, never
    // request kCGWindowName, screenshots, AX values or password-field contents.
    let raw=unsafe{CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID)};
    if raw.is_null(){return None;}
    let list:CFArray<CFDictionary<CFString,CFType>>=unsafe{CFArray::wrap_under_create_rule(raw)};
    let mut result=vec![];
    for d in list.iter().take(4096){
        let Some(pid)=number(&d,unsafe{kCGWindowOwnerPID})else{continue;};
        let Some((owner,_))=process(pid)else{continue;};if !is_security_agent(&owner.executable){continue;}
        if value(&d,unsafe{kCGWindowAlpha}).and_then(|v|v.downcast::<CFNumber>()).and_then(|v|v.to_f64()).unwrap_or(1.)<=0.05{continue;}
        let raw_bounds=value(&d,unsafe{kCGWindowBounds})?.downcast::<CFDictionary>()?;
        let bounds:CFDictionary<CFString,CFType>=unsafe{CFDictionary::wrap_under_get_rule(raw_bounds.as_concrete_TypeRef())};
        let coordinate = |key: &str| bounds.find(&CFString::new(key))
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_f64()).filter(|value| value.is_finite());
        let (Some(width), Some(height)) = (coordinate("Width"), coordinate("Height")) else {continue;};
        if width < 80. || height < 40. {continue;}
        let center = coordinate("X").zip(coordinate("Y"))
            .map(|(x, y)| (x + width / 2., y + height / 2.));
        let Some(id)=number(&d,unsafe{kCGWindowNumber}).and_then(|n|u32::try_from(n).ok())else{continue;};
        if process(pid).as_ref().map(|p|&p.0)==Some(&owner){result.push(Window{id,owner,center});}
    }
    Some(result)
}
pub(super) fn present_alert(
    window: &tauri::WebviewWindow,
    source: Option<&tauri::WebviewWindow>,
    center: Option<(f64, f64)>,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("提示窗口必须在主线程显示")?;
    let screens = NSScreen::screens(mtm);
    let primary = screens.firstObject().ok_or("无法读取显示器")?;
    let primary_frame = primary.frame();
    // WindowServer bounds use a top-left origin. AppKit positions windows in points
    // relative to the bottom-left of the primary screen, even across display scales.
    let point = center.map(|(x, y)| NSPoint::new(
        x, primary_frame.origin.y + primary_frame.size.height - y,
    )).unwrap_or_else(NSEvent::mouseLocation);
    let screen = source.and_then(|source| source.ns_window().ok())
        .and_then(|raw| unsafe { raw.cast::<NSWindow>().as_ref() })
        .and_then(NSWindow::screen)
        .or_else(|| screens.iter().find(|screen| {
            let frame = screen.frame();
            point.x >= frame.origin.x && point.x < frame.origin.x + frame.size.width
                && point.y >= frame.origin.y && point.y < frame.origin.y + frame.size.height
        }))
        .unwrap_or(primary);
    let raw = window.ns_window().map_err(|error| error.to_string())?;
    let window = unsafe { raw.cast::<NSWindow>().as_ref() }.ok_or("无法读取提示窗口")?;
    let frame = screen.visibleFrame();
    let size = window.frame().size;
    window.setFrameOrigin(NSPoint::new(
        frame.origin.x + (frame.size.width - size.width - 16.).max(0.),
        frame.origin.y + (frame.size.height - size.height - 16.).max(0.),
    ));
    window.orderFrontRegardless();
    Ok(())
}
pub(super) fn scan(at:u64)->(Option<Vec<Script>>,Option<Vec<Window>>,Option<String>){
    let scripts=scripts(at);let windows=windows();let error=if let Err(error)=&scripts {Some(error.clone())}else if windows.is_none(){Some("系统认证窗口元数据暂不可用；仍可查看脚本活动，未推断弹窗来源。".into())}else{None};(scripts.ok(),windows,error)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_protected_security_agent_path_identifies_an_authentication_ui(){
        assert!(is_security_agent("/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent"));
        for p in ["/tmp/SecurityAgent","/Applications/SecurityAgent.app/Contents/MacOS/SecurityAgent","/usr/bin/osascript"]{assert!(!is_security_agent(p));}
    }
    #[test]
    fn metadata_observation_is_bounded_and_never_collects_process_resources(){let scan=scan(super::super::now());assert!(scan.0.is_none_or(|v|v.len()<=64));assert!(scan.1.is_none_or(|v|v.len()<=4096));}
}
