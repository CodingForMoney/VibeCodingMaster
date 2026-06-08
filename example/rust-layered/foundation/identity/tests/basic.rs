#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(
        foundation_identity::module_summary(),
        "foundation::identity"
    );
}
