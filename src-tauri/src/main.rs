// 防止 Windows 发布模式下弹出控制台
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sloth_pet_lib::run()
}
