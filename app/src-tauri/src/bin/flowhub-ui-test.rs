fn main() {
    if let Err(error) = flowhub_tauri_lib::run_ui_test() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
