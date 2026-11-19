// Applies the saved theme before first paint (loaded synchronously in <head>).
(function () {
  var saved = null;
  try { saved = localStorage.getItem("edusense-theme"); } catch (e) {}
  var theme = saved === "dark" || saved === "light" ? saved
    : (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
