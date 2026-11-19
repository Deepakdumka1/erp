(function () {
  var form = document.getElementById("login-form");
  var pass = document.getElementById("password");
  var toggle = document.getElementById("password-toggle");
  toggle.addEventListener("click", function () {
    var show = pass.type === "password";
    pass.type = show ? "text" : "password";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(show));
  });
  document.querySelectorAll("[data-demo]").forEach(function (button) {
    button.addEventListener("click", function () {
      var radio = form.querySelector('input[name=role][value="' + button.dataset.demo + '"]');
      if (radio) radio.checked = true;
      form.username.value = button.dataset.user;
      pass.value = button.dataset.pass;
      ["username", "password"].forEach(function (n) { form[n].removeAttribute("aria-invalid"); document.getElementById(n + "-error").hidden = true; });
      form.querySelector("button[type=submit]").focus();
    });
  });
  form.addEventListener("submit", function (event) {
    var first = null;
    ["username", "password"].forEach(function (n) {
      var input = form[n], message = document.getElementById(n + "-error"), empty = !input.value.trim();
      message.hidden = !empty;
      if (empty) { input.setAttribute("aria-invalid", "true"); first = first || input; } else { input.removeAttribute("aria-invalid"); }
    });
    if (first) { event.preventDefault(); first.focus(); return; }
    var submit = form.querySelector("button[type=submit]");
    submit.disabled = true; submit.textContent = "Signing in…";
  });
})();
