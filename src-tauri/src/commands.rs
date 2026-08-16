// src/commands.rs
use crate::file_ops::list_files_and_directories_recursive;
use crate::models::FileOrDir;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::command;
use tauri::{AppHandle, Manager};
use tiff::decoder::{ChunkType, Decoder, DecodingResult, Limits as TiffLimits};
use tiff::ColorType as TiffColorType;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedTreeRingScanImage {
    path: String,
    mime_type: String,
    crop_applied: bool,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeRingScanCrop {
    x_ratio: f64,
    y_ratio: f64,
    width_ratio: f64,
    height_ratio: f64,
}

const TREE_RING_SCAN_CACHE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const TREE_RING_TIFF_PREVIEW_MAX_EDGE: u32 = 4096;
const TREE_RING_TIFF_PREVIEW_MAX_PIXELS: u64 = 12 * 1024 * 1024;
const TREE_RING_TIFF_CROP_MAX_PIXELS: u64 = 128 * 1024 * 1024;
const TREE_RING_TIFF_MAX_CHUNK_BYTES: usize = 512 * 1024 * 1024;
const TREE_RING_TIFF_CACHE_VERSION: &str = "chunked-crop-v3";

#[derive(Clone, Copy)]
enum TiffPixelLayout {
    Gray { channels: usize, bit_depth: u8 },
    Rgb { channels: usize, bit_depth: u8 },
}

fn tree_ring_tiff_preview_dimensions(width: u32, height: u32) -> Result<(u32, u32), String> {
    if width == 0 || height == 0 {
        return Err("TIFF 扫描影像尺寸无效".to_string());
    }
    let edge_scale = TREE_RING_TIFF_PREVIEW_MAX_EDGE as f64 / width.max(height) as f64;
    let pixel_scale =
        (TREE_RING_TIFF_PREVIEW_MAX_PIXELS as f64 / (width as f64 * height as f64)).sqrt();
    let scale = 1.0_f64.min(edge_scale).min(pixel_scale);
    Ok((
        ((width as f64 * scale).floor() as u32).clamp(1, width),
        ((height as f64 * scale).floor() as u32).clamp(1, height),
    ))
}

fn tree_ring_tiff_source_region(
    width: u32,
    height: u32,
    crop: Option<&TreeRingScanCrop>,
) -> Result<(u32, u32, u32, u32), String> {
    let Some(crop) = crop else {
        return Ok((0, 0, width, height));
    };
    if !crop.x_ratio.is_finite()
        || !crop.y_ratio.is_finite()
        || !crop.width_ratio.is_finite()
        || !crop.height_ratio.is_finite()
        || crop.width_ratio <= 0.0
        || crop.height_ratio <= 0.0
    {
        return Err("扫描影像选框无效，请重新框选样本截面".to_string());
    }
    let left = crop.x_ratio.clamp(0.0, 1.0);
    let top = crop.y_ratio.clamp(0.0, 1.0);
    let right = (crop.x_ratio + crop.width_ratio).clamp(left, 1.0);
    let bottom = (crop.y_ratio + crop.height_ratio).clamp(top, 1.0);
    if left >= 1.0 || top >= 1.0 || right <= left || bottom <= top {
        return Err("扫描影像选框超出原图，请重新框选样本截面".to_string());
    }
    let x0 = ((left * width as f64).floor() as u32).min(width - 1);
    let y0 = ((top * height as f64).floor() as u32).min(height - 1);
    let x1 = ((right * width as f64).ceil() as u32).clamp(x0.saturating_add(1), width);
    let y1 = ((bottom * height as f64).ceil() as u32).clamp(y0.saturating_add(1), height);
    let region_width = x1 - x0;
    let region_height = y1 - y0;
    let pixels = region_width as u64 * region_height as u64;
    if pixels > TREE_RING_TIFF_CROP_MAX_PIXELS {
        return Err(format!(
            "所选截面为 {} × {} 像素，范围过大；请只框选磨平后的长方形样芯截面",
            region_width, region_height
        ));
    }
    Ok((x0, y0, region_width, region_height))
}

fn source_sample_coordinate(output: u32, output_length: u32, source_length: u32) -> u32 {
    let numerator = (2 * output as u64 + 1) * source_length as u64;
    (numerator / (2 * output_length as u64)).min(source_length.saturating_sub(1) as u64) as u32
}

fn tiff_pixel_layout(color_type: TiffColorType) -> Result<TiffPixelLayout, String> {
    match color_type {
        TiffColorType::Gray(bit_depth) if bit_depth <= 16 => Ok(TiffPixelLayout::Gray {
            channels: 1,
            bit_depth,
        }),
        TiffColorType::GrayA(bit_depth) if bit_depth <= 16 => Ok(TiffPixelLayout::Gray {
            channels: 2,
            bit_depth,
        }),
        TiffColorType::RGB(bit_depth) if bit_depth <= 16 => Ok(TiffPixelLayout::Rgb {
            channels: 3,
            bit_depth,
        }),
        TiffColorType::RGBA(bit_depth) if bit_depth <= 16 => Ok(TiffPixelLayout::Rgb {
            channels: 4,
            bit_depth,
        }),
        other => Err(format!(
            "暂不支持此 TIFF 色彩类型 {:?}；请转换为 8/16 位灰度、RGB 或 RGBA",
            other
        )),
    }
}

fn tiff_sample_to_u8(decoded: &DecodingResult, index: usize, bit_depth: u8) -> Result<u8, String> {
    let value = match decoded {
        DecodingResult::U8(values) => values.get(index).copied().map(u64::from),
        DecodingResult::U16(values) => values.get(index).copied().map(u64::from),
        _ => None,
    }
    .ok_or_else(|| "TIFF 像素缓冲与声明的色彩类型不一致".to_string())?;
    let maximum = if bit_depth == 0 {
        0
    } else {
        (1_u64 << bit_depth) - 1
    };
    if maximum == 0 {
        return Err("TIFF 位深无效".to_string());
    }
    Ok(((value.min(maximum) * 255 + maximum / 2) / maximum) as u8)
}

fn composite_over_white(channel: u8, alpha: u8) -> u8 {
    ((channel as u16 * alpha as u16 + 255 * (255 - alpha as u16) + 127) / 255) as u8
}

fn decode_tiff_rgb_pixel(
    decoded: &DecodingResult,
    pixel_index: usize,
    layout: TiffPixelLayout,
) -> Result<[u8; 3], String> {
    match layout {
        TiffPixelLayout::Gray {
            channels,
            bit_depth,
        } => {
            let offset = pixel_index
                .checked_mul(channels)
                .ok_or_else(|| "TIFF 像素索引溢出".to_string())?;
            let gray = tiff_sample_to_u8(decoded, offset, bit_depth)?;
            let alpha = if channels == 2 {
                tiff_sample_to_u8(decoded, offset + 1, bit_depth)?
            } else {
                255
            };
            let gray = composite_over_white(gray, alpha);
            Ok([gray, gray, gray])
        }
        TiffPixelLayout::Rgb {
            channels,
            bit_depth,
        } => {
            let offset = pixel_index
                .checked_mul(channels)
                .ok_or_else(|| "TIFF 像素索引溢出".to_string())?;
            let alpha = if channels == 4 {
                tiff_sample_to_u8(decoded, offset + 3, bit_depth)?
            } else {
                255
            };
            Ok([
                composite_over_white(tiff_sample_to_u8(decoded, offset, bit_depth)?, alpha),
                composite_over_white(tiff_sample_to_u8(decoded, offset + 1, bit_depth)?, alpha),
                composite_over_white(tiff_sample_to_u8(decoded, offset + 2, bit_depth)?, alpha),
            ])
        }
    }
}

/// Decode only the TIFF chunks needed by a lightweight overview or the exact selected crop. This
/// avoids holding the full
/// scanner image and the TIFF decoder's intermediate buffers in memory at the same time.
fn convert_tree_ring_tiff_to_png(
    source: &Path,
    output_path: &Path,
    crop: Option<&TreeRingScanCrop>,
) -> Result<(), String> {
    let file = fs::File::open(source)
        .map_err(|error| format!("无法打开 TIFF 扫描影像 {}: {}", source.display(), error))?;
    let mut limits = TiffLimits::default();
    limits.decoding_buffer_size = TREE_RING_TIFF_MAX_CHUNK_BYTES;
    let mut decoder = Decoder::new(BufReader::new(file))
        .map_err(|error| format!("无法解析 TIFF 扫描影像 {}: {}", source.display(), error))?
        .with_limits(limits);
    let (source_width, source_height) = decoder
        .dimensions()
        .map_err(|error| format!("无法读取 TIFF 尺寸 {}: {}", source.display(), error))?;
    let layout = tiff_pixel_layout(
        decoder
            .colortype()
            .map_err(|error| format!("无法读取 TIFF 色彩类型 {}: {}", source.display(), error))?,
    )?;
    let (region_x, region_y, region_width, region_height) =
        tree_ring_tiff_source_region(source_width, source_height, crop)?;
    let (output_width, output_height) = if crop.is_some() {
        (region_width, region_height)
    } else {
        tree_ring_tiff_preview_dimensions(source_width, source_height)?
    };
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();
    if chunk_width == 0 || chunk_height == 0 {
        return Err(format!("TIFF 分块尺寸无效: {}", source.display()));
    }

    let chunks_across = match decoder.get_chunk_type() {
        ChunkType::Strip => 1,
        ChunkType::Tile => source_width.div_ceil(chunk_width),
    };
    let chunks_down = source_height.div_ceil(chunk_height);
    let expected_chunk_count = chunks_across
        .checked_mul(chunks_down)
        .ok_or_else(|| "TIFF 分块数量溢出".to_string())?;
    let actual_chunk_count = match decoder.get_chunk_type() {
        ChunkType::Strip => decoder.strip_count(),
        ChunkType::Tile => decoder.tile_count(),
    }
    .map_err(|error| format!("无法读取 TIFF 分块信息 {}: {}", source.display(), error))?;
    if actual_chunk_count != expected_chunk_count {
        return Err(format!(
            "暂不支持平面分离存储的 TIFF 扫描影像 {}",
            source.display()
        ));
    }

    let mut x_by_chunk = vec![Vec::<(u32, u32)>::new(); chunks_across as usize];
    for output_x in 0..output_width {
        let source_x = region_x + source_sample_coordinate(output_x, output_width, region_width);
        x_by_chunk[(source_x / chunk_width) as usize].push((output_x, source_x % chunk_width));
    }
    let mut y_by_chunk = vec![Vec::<(u32, u32)>::new(); chunks_down as usize];
    for output_y in 0..output_height {
        let source_y = region_y + source_sample_coordinate(output_y, output_height, region_height);
        y_by_chunk[(source_y / chunk_height) as usize].push((output_y, source_y % chunk_height));
    }

    let output_byte_length = (output_width as usize)
        .checked_mul(output_height as usize)
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or_else(|| "TIFF 预览缓冲尺寸溢出".to_string())?;
    let mut output = vec![255_u8; output_byte_length];
    for chunk_y in 0..chunks_down {
        if y_by_chunk[chunk_y as usize].is_empty() {
            continue;
        }
        for chunk_x in 0..chunks_across {
            if x_by_chunk[chunk_x as usize].is_empty() {
                continue;
            }
            let chunk_index = chunk_y * chunks_across + chunk_x;
            let (data_width, data_height) = decoder.chunk_data_dimensions(chunk_index);
            let decoded = decoder.read_chunk(chunk_index).map_err(|error| {
                format!(
                    "无法解码 TIFF 分块 {}/{} {}: {}",
                    chunk_index + 1,
                    actual_chunk_count,
                    source.display(),
                    error
                )
            })?;
            for &(output_y, local_y) in &y_by_chunk[chunk_y as usize] {
                if local_y >= data_height {
                    continue;
                }
                for &(output_x, local_x) in &x_by_chunk[chunk_x as usize] {
                    if local_x >= data_width {
                        continue;
                    }
                    let source_pixel = (local_y as usize)
                        .checked_mul(data_width as usize)
                        .and_then(|row| row.checked_add(local_x as usize))
                        .ok_or_else(|| "TIFF 分块像素索引溢出".to_string())?;
                    let rgb = decode_tiff_rgb_pixel(&decoded, source_pixel, layout)?;
                    let output_offset =
                        ((output_y as usize * output_width as usize) + output_x as usize) * 3;
                    output[output_offset..output_offset + 3].copy_from_slice(&rgb);
                }
            }
        }
    }

    let preview = image::RgbImage::from_raw(output_width, output_height, output)
        .ok_or_else(|| "无法创建 TIFF 预览缓冲".to_string())?;
    preview
        .save_with_format(output_path, image::ImageFormat::Png)
        .map_err(|error| format!("无法缓存 TIFF 扫描影像 {}: {}", source.display(), error))
}

fn prune_tree_ring_scan_cache(cache_dir: &Path, protected_path: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs())
                .unwrap_or(0);
            Some((entry.path(), metadata.len(), modified))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in files {
        if total <= TREE_RING_SCAN_CACHE_MAX_BYTES {
            break;
        }
        if path == protected_path {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

#[command]
/// Lazily copies one externally selected scan into app cache. TIFF is converted to PNG
/// so WebView2 can display it, while all other supported formats remain byte-identical.
pub fn prepare_tree_ring_scan_image(
    app: AppHandle,
    source_path: &str,
    crop: Option<TreeRingScanCrop>,
) -> Result<PreparedTreeRingScanImage, String> {
    let source = Path::new(source_path);
    let metadata = source
        .metadata()
        .map_err(|error| format!("无法读取扫描影像 {}: {}", source.display(), error))?;
    if !metadata.is_file() {
        return Err(format!("扫描影像不是文件: {}", source.display()));
    }

    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let allowed = [
        "svg", "png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff",
    ];
    if !allowed.contains(&extension.as_str()) {
        return Err(format!("不支持的扫描影像格式: .{}", extension));
    }

    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| (value.as_secs(), value.subsec_nanos()))
        .unwrap_or((0, 0));
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    if extension == "tif" || extension == "tiff" {
        TREE_RING_TIFF_CACHE_VERSION.hash(&mut hasher);
        if let Some(crop) = crop {
            crop.x_ratio.to_bits().hash(&mut hasher);
            crop.y_ratio.to_bits().hash(&mut hasher);
            crop.width_ratio.to_bits().hash(&mut hasher);
            crop.height_ratio.to_bits().hash(&mut hasher);
        }
    }
    let cache_key = hasher.finish();

    let is_tiff = extension == "tif" || extension == "tiff";
    let output_extension = if is_tiff { "png" } else { extension.as_str() };
    let mime_type = match output_extension {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    };
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位扫描影像缓存目录: {}", error))?
        .join("tree-ring-scans-v1");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("无法创建扫描影像缓存目录: {}", error))?;
    let output_path = cache_dir.join(format!("{:016x}.{}", cache_key, output_extension));

    if !output_path.exists() {
        if is_tiff {
            convert_tree_ring_tiff_to_png(source, &output_path, crop.as_ref())?;
        } else {
            fs::copy(source, &output_path)
                .map_err(|error| format!("无法缓存扫描影像 {}: {}", source.display(), error))?;
        }
    }
    prune_tree_ring_scan_cache(&cache_dir, &output_path);

    Ok(PreparedTreeRingScanImage {
        path: output_path.to_string_lossy().into_owned(),
        mime_type: mime_type.to_string(),
        crop_applied: is_tiff && crop.is_some(),
    })
}

#[cfg(test)]
mod tree_ring_tiff_tests {
    use super::{
        convert_tree_ring_tiff_to_png, tree_ring_tiff_preview_dimensions, TreeRingScanCrop,
        TREE_RING_TIFF_PREVIEW_MAX_EDGE, TREE_RING_TIFF_PREVIEW_MAX_PIXELS,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_test_directory(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "crossdating-tree-ring-{}-{}-{}",
            label,
            std::process::id(),
            suffix
        ))
    }

    #[test]
    fn limits_large_tiff_preview_without_changing_aspect_ratio() {
        let (width, height) = tree_ring_tiff_preview_dimensions(7353, 15216).unwrap();
        assert_eq!(height, TREE_RING_TIFF_PREVIEW_MAX_EDGE);
        assert!(width as u64 * height as u64 <= TREE_RING_TIFF_PREVIEW_MAX_PIXELS);
        let source_ratio = 7353.0 / 15216.0;
        let output_ratio = width as f64 / height as f64;
        assert!((source_ratio - output_ratio).abs() < 0.0002);
    }

    #[test]
    fn converts_a_chunked_rgb_tiff_to_png() {
        let directory = temporary_test_directory("tiff-conversion");
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("sample.tif");
        let output = directory.join("sample.png");
        let scan = image::RgbImage::from_fn(96, 64, |x, y| {
            image::Rgb([(x * 2) as u8, (y * 3) as u8, ((x + y) % 255) as u8])
        });
        scan.save_with_format(&source, image::ImageFormat::Tiff)
            .unwrap();

        convert_tree_ring_tiff_to_png(&source, &output, None).unwrap();
        let converted = image::open(&output).unwrap().to_rgb8();
        assert_eq!(converted.dimensions(), (96, 64));
        assert_eq!(converted.get_pixel(20, 10).0, [40, 30, 30]);

        let cropped_output = directory.join("sample-crop.png");
        convert_tree_ring_tiff_to_png(
            &source,
            &cropped_output,
            Some(&TreeRingScanCrop {
                x_ratio: 0.25,
                y_ratio: 0.25,
                width_ratio: 0.5,
                height_ratio: 0.5,
            }),
        )
        .unwrap();
        let cropped = image::open(&cropped_output).unwrap().to_rgb8();
        assert_eq!(cropped.dimensions(), (48, 32));
        assert_eq!(cropped.get_pixel(0, 0).0, [48, 48, 40]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "set TREE_RING_SCAN_TEST_TIFF to exercise a real scanner image"]
    fn converts_an_external_large_tiff_when_requested() {
        let source = std::env::var("TREE_RING_SCAN_TEST_TIFF")
            .expect("TREE_RING_SCAN_TEST_TIFF must point to a TIFF scan");
        let directory = temporary_test_directory("external-tiff");
        fs::create_dir_all(&directory).unwrap();
        let requested_output = std::env::var("TREE_RING_SCAN_TEST_OUTPUT").ok();
        let output = requested_output
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.join("preview.png"));
        let crop = std::env::var("TREE_RING_SCAN_TEST_CROP").ok().map(|value| {
            let values = value
                .split(',')
                .map(|part| part.trim().parse::<f64>().expect("crop ratio"))
                .collect::<Vec<_>>();
            assert_eq!(values.len(), 4, "crop is x,y,width,height");
            TreeRingScanCrop {
                x_ratio: values[0],
                y_ratio: values[1],
                width_ratio: values[2],
                height_ratio: values[3],
            }
        });
        convert_tree_ring_tiff_to_png(PathBuf::from(source).as_path(), &output, crop.as_ref())
            .unwrap();
        let (width, height) = image::image_dimensions(&output).unwrap();
        if crop.is_none() {
            assert!(width.max(height) <= TREE_RING_TIFF_PREVIEW_MAX_EDGE);
            assert!(width as u64 * height as u64 <= TREE_RING_TIFF_PREVIEW_MAX_PIXELS);
        }
        println!(
            "converted TIFF output: {} ({} × {})",
            output.display(),
            width,
            height
        );
        if requested_output.is_none() {
            fs::remove_dir_all(directory).unwrap();
        }
    }
}

#[command]
/// Tauri命令: 列出指定目录的文件和子目录
pub fn list_files_and_directories(dir_path: &str) -> Result<FileOrDir, String> {
    list_files_and_directories_recursive(dir_path).map_err(|e| e.to_string()) // 转换为String错误类型
}

#[command]
/// Tauri命令: 打招呼
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[command]
/// Write OUT content next to the source RWL file and return the saved path.
pub fn write_out_next_to_rwl(source_rwl_path: &str, out_text: &str) -> Result<String, String> {
    let src = Path::new(source_rwl_path);
    let parent = src
        .parent()
        .ok_or_else(|| format!("invalid source path, no parent: {}", source_rwl_path))?;

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("invalid source path, no file stem: {}", source_rwl_path))?;

    let out_path = parent.join(format!("{}.OUT", stem));
    fs::write(&out_path, out_text)
        .map_err(|e| format!("failed to write OUT file {}: {}", out_path.display(), e))?;

    Ok(out_path.to_string_lossy().into_owned())
}
