import { transpileTypescript } from "./index.js";
if (import.meta.url === `file://${process.argv[1]}`) {
  const i1 = `
  return (async function () {
    sharedState.AnthropicApi = {
        async promptAsync(prompt, onError: (retry, abort) => Promise<void>) {
            const request = {
                "model": config.Model,
                "messages": [{ "role": "user", "content": prompt }],
                "stream": false,
                "max_tokens": 1000
            };
        }
    }    
})();
`;

  const result = await transpileTypescript(
    i1,
    "http://localhost:8080/dev.ts",
    ["window", "document"],
    ["sharedState", "config", "background"],
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
