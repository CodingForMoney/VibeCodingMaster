pub mod model;
pub mod ops;

pub use model::default_resource;

pub fn module_name() -> &'static str {
    "config"
}

pub(crate) fn layer_name() -> &'static str {
    "foundation"
}

pub fn module_summary() -> String {
    format!("{}::{}", layer_name(), module_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_summary_matches_layer_and_module() {
        assert_eq!(module_summary(), "foundation::config");
    }
}
