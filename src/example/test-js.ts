import { RunOptions, RunTarget } from "github-action-ts-run-api";
import { run } from "../main";

const fun = async () => {
  const target = RunTarget.asyncFn(run as any);
  const options = RunOptions.create().setInputs({
    mainBranch: "temp-check/gh-actions",
    targetBranch: "temp-check/gh-actions",
    repo: "anki872198/CI-CD-CHECK-BRANCH",
    services:
      "account-service, payment-service, orderbook-service, registry-service",
    value:
      "australia-southeast1-docker.pkg.dev/vital-contact-300805/powerledger-platform/tracex-web-app:5.5.6",
    environment: "staging",
    message: "Temp Check",
    createPR: "${{steps.pr-check.outputs.pr_exist!='true'}}",
    labels: "staging-tags",
    token: "${{secrets.GITHUB_TOKEN}}",
  });

  const result = await target.run(options);
};
