const COMMANDS: &[&str] = &["open", "send", "close"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
