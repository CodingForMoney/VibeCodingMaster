#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(domain_accounts::module_summary(), "domain::accounts");
}
