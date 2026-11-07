use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::io::AsyncWriteExt;
use tracing::*;

use crate::{http_client::HttpClient, i18n::tr};

const FONT_FOLDER: &str = "fonts";
const GOOGLE_FONTS: &str =
    "https://raw.githubusercontent.com/google/fonts/86aced91de05cd4f96a06838124cca45be337b2b";
const NOTO_CJK: &str =
    "https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const LXGW_WENKAI: &str = "https://github.com/lxgw/LxgwWenKai/releases/download/v1.530";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FontCategory {
    Sans,
    Serif,
    Display,
    Handwriting,
    Mono,
}

struct FontFile {
    base: &'static str,
    path: &'static str,
    size: u32,
    sha256: &'static str,
}

impl FontFile {
    fn name(&self) -> &'static str {
        self.path.rsplit('/').next().unwrap_or(self.path)
    }

    fn url(&self) -> String {
        format!("{}/{}", self.base, self.path)
    }
}

struct CatalogFont {
    id: &'static str,
    family: &'static str,
    chinese_name: Option<&'static str>,
    category: FontCategory,
    cjk: bool,
    files: &'static [FontFile],
}

const fn file(base: &'static str, path: &'static str, size: u32, sha256: &'static str) -> FontFile {
    FontFile {
        base,
        path,
        size,
        sha256,
    }
}

const CATALOG: &[CatalogFont] = &[
    CatalogFont {
        id: "poppins",
        family: "Poppins",
        chinese_name: None,
        category: FontCategory::Sans,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/poppins/Poppins-Regular.ttf",
                160316,
                "7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/poppins/Poppins-Bold.ttf",
                155996,
                "983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c",
            ),
        ],
    },
    CatalogFont {
        id: "lato",
        family: "Lato",
        chinese_name: None,
        category: FontCategory::Sans,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/lato/Lato-Regular.ttf",
                656568,
                "d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/lato/Lato-Bold.ttf",
                656544,
                "8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1",
            ),
        ],
    },
    CatalogFont {
        id: "fira-sans",
        family: "Fira Sans",
        chinese_name: None,
        category: FontCategory::Sans,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/firasans/FiraSans-Regular.ttf",
                456996,
                "c29556a2719bf613ef3d5e070e40d903a8965d9c081beca1375dc1e6e0f93c23",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/firasans/FiraSans-Bold.ttf",
                489720,
                "a4d8e149ecdd4874a0726eb0af894488b3b31c423d6b0017c8f415ed1b795b45",
            ),
        ],
    },
    CatalogFont {
        id: "barlow",
        family: "Barlow",
        chinese_name: None,
        category: FontCategory::Sans,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/barlow/Barlow-Regular.ttf",
                104068,
                "95aa02c7c43096e0dd44d787ba6216864a67157e402adab59b35572e0c1577ea",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/barlow/Barlow-Bold.ttf",
                108220,
                "84e6a4d61e7c3e21f3c50ea6a4f7e5303a3467864c038be6ea3759bab8d547f9",
            ),
        ],
    },
    CatalogFont {
        id: "kanit",
        family: "Kanit",
        chinese_name: None,
        category: FontCategory::Sans,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/kanit/Kanit-Regular.ttf",
                173148,
                "27170c049660b2f962d3ed28441fd20f4c743503ca031fec9c2b4542d6c52736",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/kanit/Kanit-Bold.ttf",
                176136,
                "5dec5b080dab13de9d2295437c0ff3ec05c9e75587dfc31358c005eb4efa5e70",
            ),
        ],
    },
    CatalogFont {
        id: "titillium-web",
        family: "Titillium Web",
        chinese_name: None,
        category: FontCategory::Sans,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/titilliumweb/TitilliumWeb-Regular.ttf",
                63660,
                "7b6b4452c65cc8b8522e92e7d4d4c2e6d7675341ceafd041bb6bd30297517ea5",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/titilliumweb/TitilliumWeb-Bold.ttf",
                59884,
                "e2e8e1812041e2c5868f1d03ac24994312052c5381cca2e80748f08cb7e13093",
            ),
        ],
    },
    CatalogFont {
        id: "bebas-neue",
        family: "Bebas Neue",
        chinese_name: None,
        category: FontCategory::Display,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/bebasneue/BebasNeue-Regular.ttf",
            61400,
            "08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73",
        )],
    },
    CatalogFont {
        id: "anton",
        family: "Anton",
        chinese_name: None,
        category: FontCategory::Display,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/anton/Anton-Regular.ttf",
            170812,
            "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab",
        )],
    },
    CatalogFont {
        id: "archivo-black",
        family: "Archivo Black",
        chinese_name: None,
        category: FontCategory::Display,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/archivoblack/ArchivoBlack-Regular.ttf",
            90988,
            "dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180",
        )],
    },
    CatalogFont {
        id: "lilita-one",
        family: "Lilita One",
        chinese_name: None,
        category: FontCategory::Display,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/lilitaone/LilitaOne-Regular.ttf",
            28092,
            "f5b641c45c69d772ee4eda687bc9fda411d5cad6b0b45371491da4580cbc8d59",
        )],
    },
    CatalogFont {
        id: "bangers",
        family: "Bangers",
        chinese_name: None,
        category: FontCategory::Display,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/bangers/Bangers-Regular.ttf",
            93148,
            "4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824",
        )],
    },
    CatalogFont {
        id: "permanent-marker",
        family: "Permanent Marker",
        chinese_name: None,
        category: FontCategory::Handwriting,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "apache/permanentmarker/PermanentMarker-Regular.ttf",
            74632,
            "28f82c8a7943cb8e9d599f8554da1d4fc75dbcf69b9885ad6c0611d20c6946c5",
        )],
    },
    CatalogFont {
        id: "pacifico",
        family: "Pacifico",
        chinese_name: None,
        category: FontCategory::Handwriting,
        cjk: false,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/pacifico/Pacifico-Regular.ttf",
            329380,
            "5b6c0d5334a7bf77dea52b975c5a0c408878c0f7115ed5b6fb151f634b7bf701",
        )],
    },
    CatalogFont {
        id: "pt-serif",
        family: "PT Serif",
        chinese_name: None,
        category: FontCategory::Serif,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/ptserif/PT_Serif-Web-Regular.ttf",
                359048,
                "a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/ptserif/PT_Serif-Web-Bold.ttf",
                339996,
                "038ba7336bd7ea14f12ad155bed51a4345cac5153275d521dec3ba04021c526e",
            ),
        ],
    },
    CatalogFont {
        id: "ibm-plex-mono",
        family: "IBM Plex Mono",
        chinese_name: None,
        category: FontCategory::Mono,
        cjk: false,
        files: &[
            file(
                GOOGLE_FONTS,
                "ofl/ibmplexmono/IBMPlexMono-Regular.ttf",
                135580,
                "6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46",
            ),
            file(
                GOOGLE_FONTS,
                "ofl/ibmplexmono/IBMPlexMono-Bold.ttf",
                137784,
                "ac27abd6450a64dd94467580a02fe6235156d5b92f2926ebbc8e7489df64e0be",
            ),
        ],
    },
    CatalogFont {
        id: "noto-sans-sc",
        family: "Noto Sans SC",
        chinese_name: Some("思源黑体"),
        category: FontCategory::Sans,
        cjk: true,
        files: &[
            file(
                NOTO_CJK,
                "Sans/SubsetOTF/SC/NotoSansSC-Regular.otf",
                8331336,
                "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9",
            ),
            file(
                NOTO_CJK,
                "Sans/SubsetOTF/SC/NotoSansSC-Bold.otf",
                8543168,
                "c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0",
            ),
        ],
    },
    CatalogFont {
        id: "noto-serif-sc",
        family: "Noto Serif SC",
        chinese_name: Some("思源宋体"),
        category: FontCategory::Serif,
        cjk: true,
        files: &[
            file(
                NOTO_CJK,
                "Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf",
                11625800,
                "e8f396decc1f0963a016a989c3d8852e863d1350996f573860a80767c83a1cd3",
            ),
            file(
                NOTO_CJK,
                "Serif/SubsetOTF/SC/NotoSerifSC-Bold.otf",
                12094336,
                "24693d48bdb9152f0a06b02af625638a1097abd6de4010ebba027f6e82710527",
            ),
        ],
    },
    CatalogFont {
        id: "lxgw-wenkai",
        family: "LXGW WenKai",
        chinese_name: Some("霞鹜文楷"),
        category: FontCategory::Handwriting,
        cjk: true,
        files: &[
            file(
                LXGW_WENKAI,
                "LXGWWenKai-Regular.ttf",
                25928940,
                "2d73eea94ad808999d90c0000c239a84a33b09d4bc6ab6c5b8bbf1eda8a7fc8b",
            ),
            file(
                LXGW_WENKAI,
                "LXGWWenKai-Medium.ttf",
                25800076,
                "f4b8a34d1f838fe411540cb7c97b1c384ac9738a876c4104500bc42508b2312a",
            ),
        ],
    },
    CatalogFont {
        id: "zcool-kuaile",
        family: "ZCOOL KuaiLe",
        chinese_name: Some("站酷快乐体"),
        category: FontCategory::Display,
        cjk: true,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf",
            1514968,
            "812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d",
        )],
    },
    CatalogFont {
        id: "zcool-xiaowei",
        family: "ZCOOL XiaoWei",
        chinese_name: Some("站酷小薇体"),
        category: FontCategory::Serif,
        cjk: true,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/zcoolxiaowei/ZCOOLXiaoWei-Regular.ttf",
            6313808,
            "a42b620140f493db42f741351dfbf343c0936d58588ee8004b8b2a218d997ff1",
        )],
    },
    CatalogFont {
        id: "zcool-qingke-huangyou",
        family: "ZCOOL QingKe HuangYou",
        chinese_name: Some("站酷庆科黄油体"),
        category: FontCategory::Display,
        cjk: true,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/zcoolqingkehuangyou/ZCOOLQingKeHuangYou-Regular.ttf",
            8328684,
            "54f0c0df4308cd74cd0f2fd3494ae054dbc4a1fd6fa7d71f4807eb4cdd8b4136",
        )],
    },
    CatalogFont {
        id: "ma-shan-zheng",
        family: "Ma Shan Zheng",
        chinese_name: Some("马善政楷书"),
        category: FontCategory::Handwriting,
        cjk: true,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/mashanzheng/MaShanZheng-Regular.ttf",
            5857936,
            "6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb",
        )],
    },
    CatalogFont {
        id: "zhi-mang-xing",
        family: "Zhi Mang Xing",
        chinese_name: Some("志莽行书"),
        category: FontCategory::Handwriting,
        cjk: true,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/zhimangxing/ZhiMangXing-Regular.ttf",
            4063532,
            "644e0cae9b40f0b10ab729a01bd32032e3973bac22be3dccae01bf6ae7fde969",
        )],
    },
    CatalogFont {
        id: "long-cang",
        family: "Long Cang",
        chinese_name: Some("龙藏体"),
        category: FontCategory::Handwriting,
        cjk: true,
        files: &[file(
            GOOGLE_FONTS,
            "ofl/longcang/LongCang-Regular.ttf",
            5162508,
            "e5bf2c3f24ef2327c6f136d8f73e2f9dfdf44896fdbeb35a9515f44777bb91bc",
        )],
    },
];

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptionFont {
    pub id: String,
    pub family: String,
    pub name: String,
    pub category: FontCategory,
    pub cjk: bool,
    pub size_bytes: u32,
    pub downloaded: bool,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CaptionFontDownloadProgress {
    pub font_id: String,
    pub progress: f64,
}

pub fn font_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(FONT_FOLDER))
        .map_err(|e| e.to_string())
}

fn is_downloaded(dir: &Path, font: &CatalogFont) -> bool {
    font.files.iter().all(|file| {
        std::fs::metadata(dir.join(file.name()))
            .is_ok_and(|metadata| metadata.len() == u64::from(file.size))
    })
}

fn describe(dir: &Path, font: &CatalogFont) -> CaptionFont {
    let downloaded = is_downloaded(dir, font);
    CaptionFont {
        id: font.id.to_string(),
        family: font.family.to_string(),
        name: match font.chinese_name {
            Some(chinese) => tr(chinese, font.family).to_string(),
            None => font.family.to_string(),
        },
        category: font.category,
        cjk: font.cjk,
        size_bytes: font.files.iter().map(|file| file.size).sum(),
        downloaded,
        files: if downloaded {
            font.files
                .iter()
                .map(|file| dir.join(file.name()).to_string_lossy().into_owned())
                .collect()
        } else {
            Vec::new()
        },
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn list_caption_fonts(app: AppHandle) -> Result<Vec<CaptionFont>, String> {
    let dir = font_dir(&app)?;
    Ok(CATALOG.iter().map(|font| describe(&dir, font)).collect())
}

async fn download_file(
    app: &AppHandle,
    client: &reqwest::Client,
    font_id: &str,
    file: &FontFile,
    target: &Path,
    done: &mut u64,
    total: u64,
) -> Result<(), String> {
    let failed = |detail: String| {
        format!(
            "{}{}: {detail}",
            tr("字体下载失败 ", "Font download failed for "),
            file.name()
        )
    };

    let mut response = client
        .get(file.url())
        .send()
        .await
        .map_err(|e| failed(e.to_string()))?;
    if !response.status().is_success() {
        return Err(failed(format!("HTTP {}", response.status())));
    }

    let partial = target.with_extension("part");
    let mut output = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| failed(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut last_reported = 0.0;

    let result: Result<(), String> = async {
        while let Some(chunk) = response.chunk().await.map_err(|e| failed(e.to_string()))? {
            hasher.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|e| failed(e.to_string()))?;
            *done += chunk.len() as u64;

            let progress = (*done as f64 / total.max(1) as f64).min(1.0);
            if progress - last_reported >= 0.01 {
                last_reported = progress;
                CaptionFontDownloadProgress {
                    font_id: font_id.to_string(),
                    progress,
                }
                .emit(app)
                .ok();
            }
        }
        output.flush().await.map_err(|e| failed(e.to_string()))?;
        drop(output);

        let digest = hasher.finalize();
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        if hex != file.sha256 {
            return Err(failed(
                tr("文件校验不一致", "checksum mismatch").to_string(),
            ));
        }

        tokio::fs::rename(&partial, target)
            .await
            .map_err(|e| failed(e.to_string()))
    }
    .await;

    if result.is_err() {
        tokio::fs::remove_file(&partial).await.ok();
    }
    result
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub async fn download_caption_font(app: AppHandle, font_id: String) -> Result<CaptionFont, String> {
    let font = CATALOG
        .iter()
        .find(|font| font.id == font_id)
        .ok_or_else(|| tr("未知字体", "Unknown font").to_string())?;

    let dir = font_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    if is_downloaded(&dir, font) {
        return Ok(describe(&dir, font));
    }

    let client = reqwest::Client::clone(&app.state::<HttpClient>());
    let total: u64 = font.files.iter().map(|file| u64::from(file.size)).sum();
    let mut done = 0;

    for file in font.files {
        let target = dir.join(file.name());
        if std::fs::metadata(&target).is_ok_and(|metadata| metadata.len() == u64::from(file.size)) {
            done += u64::from(file.size);
            continue;
        }
        download_file(&app, &client, font.id, file, &target, &mut done, total).await?;
    }

    CaptionFontDownloadProgress {
        font_id: font.id.to_string(),
        progress: 1.0,
    }
    .emit(&app)
    .ok();

    info!("Downloaded caption font {}", font.family);
    Ok(describe(&dir, font))
}

#[cfg(test)]
mod tests {
    use super::CATALOG;

    #[test]
    fn catalog_is_consistent() {
        let mut ids = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for font in CATALOG {
            assert!(ids.insert(font.id), "duplicate id {}", font.id);
            assert!(!font.files.is_empty());
            for file in font.files {
                assert!(names.insert(file.name()), "duplicate file {}", file.name());
                assert_eq!(file.sha256.len(), 64);
                assert!(file.url().starts_with("https://"));
                let lower = file.name().to_ascii_lowercase();
                assert!(lower.ends_with(".ttf") || lower.ends_with(".otf"));
            }
        }
        assert!(CATALOG.len() >= 20);
    }
}
