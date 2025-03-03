use crate::models::FileOrDir;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::{fs, io};


// const result = await invoke("list_files_and_directories", { dirPath: file_url }) as IFileResult;

pub fn list_files_and_directories_recursive<P: AsRef<Path>>(path: P) -> io::Result<FileOrDir> {
    let path = path.as_ref();
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let is_directory = path.is_dir();

    // 创建 FileOrDir 实例
    let mut file_or_dir = FileOrDir::new(name, path.to_string_lossy().into_owned(), is_directory);

    if is_directory {
        // 如果是目录，递归读取目录内容
        for entry in fs::read_dir(path)? {
            let entry = entry?; // 获取每个条目
            let entry_path = entry.path();
            let child = list_files_and_directories_recursive(entry_path)?; // 递归调用处理子条目
            file_or_dir.add_child(child); // 将子条目添加到当前目录中
        }
    } else {
        // 如果是文件，读取文件内容
        if path.is_file() {
            if let Ok(mut file) = File::open(path) {
                let mut content = String::new();
                if let Err(e) = file.read_to_string(&mut content) {
                    // 如果文件读取失败，返回错误
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("Failed to read file {}: {}", path.display(), e),
                    ));
                }
                file_or_dir.set_content(content); // 设置文件内容
            }
        }
    }

    Ok(file_or_dir)
}
