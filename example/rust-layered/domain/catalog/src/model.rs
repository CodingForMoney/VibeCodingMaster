pub fn default_resource() -> &'static str {
    "catalog-entry"
}

pub fn resource_key(id: &str) -> String {
    let trimmed = id.trim();
    if accepts_resource(trimmed) {
        format!("{}:{}", crate::module_name(), trimmed)
    } else {
        crate::module_name().to_string()
    }
}

pub(crate) fn accepts_resource(id: &str) -> bool {
    !id.trim().is_empty()
}
