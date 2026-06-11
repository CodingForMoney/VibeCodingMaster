#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(
        application_reporting::module_summary(),
        "application::reporting"
    );
}
