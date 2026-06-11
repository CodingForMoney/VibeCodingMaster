pub mod model;
pub mod ops;

pub fn module_name() -> &'static str {
    "orders"
}

pub(crate) fn layer_name() -> &'static str {
    "domain"
}

pub fn module_summary() -> String {
    format!("{}::{}", layer_name(), module_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_summary_matches_layer_and_module() {
        assert_eq!(module_summary(), "domain::orders");
    }
}
