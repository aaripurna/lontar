const COMMANDS: &[&str] = &[
    "pick_folder",
    "release_folder",
    "scan",
    "read_book",
    "read_sidecar",
    "write_sidecar",
    "read_sidecar_conflicts",
    "delete_sidecar_conflict",
    "delete_sidecar",
    "set_bar_colors",
    "take_opened_books",
    "move_to_background",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
