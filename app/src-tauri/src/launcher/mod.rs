//! 启动器：应用启动与窗口可见性。
#[cfg(target_os = "macos")]
pub(crate) mod app;
pub(crate) mod visibility;
