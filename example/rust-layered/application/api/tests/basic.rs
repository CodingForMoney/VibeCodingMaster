#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(application_api::module_summary(), "application::api");
}
