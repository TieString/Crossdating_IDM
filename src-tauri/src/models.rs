// src/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct FileOrDir {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub children: Vec<FileOrDir>,
    pub content: Option<String>,
}

impl FileOrDir {
    pub fn new(name: String, path: String, is_directory: bool) -> Self {
        FileOrDir {
            name,
            path,
            is_directory,
            children: Vec::new(),
            content: None,
        }
    }

    pub fn add_child(&mut self, child: FileOrDir) {
        self.children.push(child);
    }

    pub fn set_content(&mut self, content: String) {
        self.content = Some(content);
    }
}
