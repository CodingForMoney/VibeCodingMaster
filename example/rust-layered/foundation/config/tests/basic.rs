#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(foundation_config::module_summary(), "foundation::config");
}
