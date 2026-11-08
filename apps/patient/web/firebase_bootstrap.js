// Match firebase_core_web's supportedFirebaseJsSdkVersion (pubspec.lock).
// Preload modules in an external script so FlutterFire need not inject inline
// loader scripts. Keep script-src free of unsafe-inline and unsafe-eval.
const version = '12.7.0';
// Analytics is registered by FlutterFire but is not enabled for public Web.
// Prevent its automatic inline loader; do not loosen the application's CSP.
window.flutterfire_ignore_scripts = ['analytics'];
try {
  const services = [
    ['app', 'core'], ['auth', 'auth'], ['app-check', 'app_check'],
    ['firestore', 'firestore'], ['database', 'database'], ['storage', 'storage'],
  ];
  const modules = await Promise.all(services.map(async ([name, global]) => [
    global, await import(`https://www.gstatic.com/firebasejs/${version}/firebase-${name}.js`),
  ]));
  for (const [name, module] of modules) window[`firebase_${name}`] = module;
  const loader = document.createElement('script');
  loader.src = 'flutter_bootstrap.js';
  loader.async = true;
  document.body.appendChild(loader);
} catch {
  document.body.textContent = '起動に必要な接続を確認できません。時間をおいて、開き直してください。';
}
