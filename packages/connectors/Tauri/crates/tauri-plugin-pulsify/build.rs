const COMMANDS: &[&str] = &["open", "send", "close", "mark_deleted", "cached"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
