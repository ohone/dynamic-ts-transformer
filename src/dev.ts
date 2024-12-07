import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  const i1 = `       
                            const iterable = [...newNode.attributes];
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
