#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(
        foundation_telemetry::module_summary(),
        "foundation::telemetry"
    );
}
