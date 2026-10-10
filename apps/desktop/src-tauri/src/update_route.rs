use tauri::Url;

/// GitHub acceleration services accept the complete GitHub URL after an HTTPS prefix.
pub fn normalize_mirror(value: &str) -> Result<String, String> {
    let prefix = value.trim();
    if prefix.is_empty() {
        return Ok(String::new());
    }
    let invalid = "请输入 HTTPS 加速地址，不要包含账号、密码、查询参数或片段";
    if prefix.chars().any(|c| c.is_whitespace() || c == '\\') {
        return Err(invalid.into());
    }
    let url = Url::parse(prefix).map_err(|_| invalid.to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid.into());
    }
    Ok(format!("{}/", url.as_str().trim_end_matches('/')))
}

pub fn download_url(original: &Url, mirror: &str) -> Result<Url, String> {
    if mirror.is_empty()
        || original.scheme() != "https"
        || original.host_str() != Some("github.com")
    {
        return Ok(original.clone());
    }
    Url::parse(&format!("{}{}", normalize_mirror(mirror)?, original)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_manifests_and_assets_through_the_selected_mirror() {
        for path in [
            "latest/download/latest.json",
            "latest/download/latest-android.json",
            "download/v1.2.3/Pier_1.2.3_x64.AppImage",
        ] {
            let original = Url::parse(&format!(
                "https://github.com/yiranxiaohui/Pier/releases/{path}"
            ))
            .unwrap();
            assert_eq!(download_url(&original, "").unwrap(), original);
            assert_eq!(
                download_url(&original, " https://mirror.example/proxy/// ")
                    .unwrap()
                    .as_str(),
                format!("https://mirror.example/proxy/{original}")
            );
        }
    }

    #[test]
    fn preserves_custom_endpoints_and_already_mirrored_urls() {
        for source in [
            "https://updates.example/latest.json",
            "https://mirror.example/https://github.com/o/r/a",
        ] {
            let original = Url::parse(source).unwrap();
            assert_eq!(
                download_url(&original, "https://mirror.example/").unwrap(),
                original
            );
        }
    }

    #[test]
    fn rejects_invalid_or_ambiguous_prefixes() {
        for prefix in [
            "http://mirror.example",
            "file:///tmp",
            "example.com",
            "https://user:pass@mirror.example",
            "https://mirror.example/?token=x",
            "https://mirror.example/#x",
            "https://mirror.example/a b",
            "https://mirror.example\\proxy",
        ] {
            assert!(normalize_mirror(prefix).is_err(), "{prefix}");
        }
        assert_eq!(normalize_mirror("  ").unwrap(), "");
    }
}
