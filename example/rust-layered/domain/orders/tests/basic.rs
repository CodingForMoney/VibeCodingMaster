#[test]
fn module_summary_matches_layer_and_module() {
    assert_eq!(domain_orders::module_summary(), "domain::orders");
}
