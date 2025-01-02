import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  const i1 = `
  window.foo.bar.baz;
  
  window.foo; // await window.foo
  window[0]; // await window[0]
  window.hello("hello!");
  window.foo.bar.baz; // await (await (await myProxy.foo).bar).baz
  window.foo(arg1, arg2); // await (await window.foo)(arg1, arg2)
  window.x.y()(z); // await (await (await window.x).y())(z)

  const a = window.foo; // const a = await window.foo
  const b = window[0];
  const c = window.foo();


  const a = window.foo(window.x).hello();


  window.something(window.a);
  
  // await window.__setProp("foo", 1)
  window.foo = 1;
  // await window.__setProp(0, 1)
  window[0] = 1; 

  // comparisons
  const sum = window.a + 10; // const sum = (await window.a) + 10
  if (window.x > 5){} // if ((await window.x) > 5) {}
  window.x && window.y; // (await window.x) && (await window.y)
  
  // loops and iteration
  for (const x of window) {} // for await (const x of window) {}
  
  `;

  const result = await transpileTypescript(
    i1,
    "http://localhost:8080/dev.ts",
    ["window", "document", "chrome"],
    ["sharedState", "config", "background", "IsProxy", "ripulConfig", "console"],
    false
  );

  console.log("--------------------------------");
  console.log(result);
}

/*
    const input = document.createElement("input");
    window.addEventListener("message", (event) => {
      const b = input.value;
*/
