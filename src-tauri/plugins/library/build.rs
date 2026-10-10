const COMMANDS: &[&str] = &[
    "pick_folder",
    "release_folder",
    "scan",
    "read_book",
    "read_sidecar",
    "write_sidecar",
    "read_sidecar_conflicts",
    "delete_sidecar_conflict",
    "set_bar_colors",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
