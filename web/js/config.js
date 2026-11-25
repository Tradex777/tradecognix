/*
 * TradeCognix front-end configuration.
 *
 * TC_API_BASE is the TradeCognix engine (FastAPI backend). There is no demo mode: when the engine
 * is unreachable the app says so instead of simulating. ?api=https://... overrides it for testing.
 */
(function () {
  var ENGINE = "https://tradecognix-api-fr5o.onrender.com"; // Render free (spins down when idle; first request can take ~50s)
  var params = new URLSearchParams(window.location.search);
  var fromQuery = params.get("api");
  if (fromQuery === "default") localStorage.removeItem("tc_api_base");
  else if (fromQuery && /^https?:\/\//.test(fromQuery)) localStorage.setItem("tc_api_base", fromQuery.replace(/\/+$/, ""));
  window.TC_API_BASE = window.TC_API_BASE || localStorage.getItem("tc_api_base") || ENGINE;
})();
