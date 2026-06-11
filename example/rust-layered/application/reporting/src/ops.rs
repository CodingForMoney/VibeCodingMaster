pub fn normalize(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

pub fn describe(id: &str) -> String {
    format!(
        "{} handles {} with priority {}",
        crate::module_summary(),
        normalize(id),
        priority(id.len())
    )
}

pub(crate) fn priority(seed: usize) -> usize {
    seed + crate::module_name().len()
}
