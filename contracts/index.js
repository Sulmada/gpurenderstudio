console.log("[DEBUG] contracts.confirm resolves to:", require.resolve("./api_confirm"));

module.exports = {
  precheck: require("./api_precheck"),
  confirm: require("./api_confirm")
};
