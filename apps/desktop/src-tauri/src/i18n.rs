use std::sync::LazyLock;

static IS_CHINESE: LazyLock<bool> = LazyLock::new(|| {
    sys_locale::get_locale().is_some_and(|locale| locale.to_lowercase().starts_with("zh"))
});

pub fn tr(chinese: &'static str, english: &'static str) -> &'static str {
    if *IS_CHINESE { chinese } else { english }
}
