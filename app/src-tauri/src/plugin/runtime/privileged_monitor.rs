use serde_json::Value;
#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn flowhub_privileged_monitor(action: *const std::ffi::c_char, output: *mut std::ffi::c_char, capacity: usize) -> i32;
}

pub(crate) async fn invoke(action: &str) -> Result<Value, String> {
    if !matches!(action, "status" | "enable" | "disable") {
        return Err("不支持的系统进程授权操作".into());
    }
    #[cfg(not(target_os = "macos"))]
    return Err("系统级进程授权只支持 macOS。".into());

    #[cfg(target_os = "macos")]
    {
        let action = CString::new(action).map_err(|error| error.to_string())?;
        let mut output = vec![0i8; 8192];
        let result = unsafe { flowhub_privileged_monitor(action.as_ptr(), output.as_mut_ptr(), output.len()) };
        if result != 0 {
            return Err("系统进程授权服务返回无效结果。".into());
        }
        let response = unsafe { CStr::from_ptr(output.as_ptr()) }.to_bytes();
        serde_json::from_slice(response).map_err(|error| format!("系统进程授权服务返回无效状态：{error}"))
    }
}
