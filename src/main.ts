import * as YAML from "js-yaml";
import * as fs from "fs";
import * as path from "path";
import jp from "jsonpath";
import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";

const getRepoInfo = (repo: string) => repo.split("/");

const serviceEmail = "dev@powerledger.io";
const serviceUserName = "pl-machine-account";

export enum Environment {
  Staging = "staging",
  Sandbox = "sandbox",
  Production = "production",
}

export type Options = {
  token: string;
  labels: string;
  message: string;
  title: string;
  description: string;
  repo: string;
  mainBranch: string;
  targetBranch: string;
  createPR: boolean;
  syncWith: string;
  branch: string;
  directPush: boolean;
};

export const run = () => {
  updateAllImages(
    core.getInput("services"),
    core.getInput("environment") as Environment,
    {
      createPR: core.getBooleanInput("createPR", { required: true }),
      token: core.getInput("token"),
      repo: core.getInput("repo"),
      labels: core.getInput("labels"),
      message: core.getInput("message"),
      title: core.getInput("title"),
      description: core.getInput("description"),
      mainBranch: core.getInput("mainBranch"),
      targetBranch: core.getInput("targetBranch"),
      syncWith: core.getInput("syncWith"),
      branch: core.getInput("branch"),
      directPush: core.getBooleanInput("directPush", { required: true }),
    },
    core.getInput("workDir")
  );
};

export const Parser = {
  convert(filePath: string) {
    return YAML.load(fs.readFileSync(filePath, "utf8")) as Record<string, any>;
  },
  dump(content: any): string {
    return YAML.dump(content, {
      lineWidth: -1,
    });
  },
};

/**
 *
 * @param files comma separated string
 * @param environment
 */
const updateAllImages = async (
  services: string,
  environment: Environment,
  options: Options,
  workDir = "."
) => {
  try {
    const [repoOwner, repo] = getRepoInfo(options.repo);
    const octokit = new Octokit({
      auth: options.token,
      baseUrl: "https://api.github.com",
    });

    const servicesArray = services.split(",");

    const filesContent: any[] = [];
    for await (const service of servicesArray) {
      const file = `apps/${service.trim()}/overlays/${environment.trim()}/patch-deployment.yml`;
      const filePath = path.join(process.cwd(), workDir, file);

      let contentNode = Parser.convert(filePath);
      let contentString = Parser.dump(contentNode);

      const initContent = contentString;
      const refFile = `apps/${service.trim()}/overlays/${options.syncWith.trim()}/patch-deployment.yml`;
      const doc: any = Parser.convert(
        path.join(process.cwd(), workDir, refFile)
      );

      core.setOutput(
        "valueToReplace",
        doc.spec.template.spec.containers[0].image
      );

      contentNode = replace(
        doc.spec.template.spec.containers[0].image,
        contentNode
      );

      contentString = Parser.dump(contentNode);

      if (initContent === contentString) {
        continue;
      }

      const changedFile = {
        relativePath: file,
        absolutePath: filePath,
        content: contentString,
        json: contentNode,
      };
      fs.writeFile(filePath, contentString, (err) => {
        if (!err) return;

        console.log("error");
      });
      filesContent.push(changedFile);
    }

    if (!filesContent?.length) {
      return null;
    }

    const branch = options.directPush
      ? options.mainBranch
      : options.branch || `${environment}-tags`;
    const { commitSha, treeSha } = await getCurrentCommit(
      octokit,
      branch,
      repoOwner,
      repo
    );

    core.debug(JSON.stringify({ baseCommit: commitSha, baseTree: treeSha }));
    const debugFiles: { [file: string]: string } = {};

    for await (const file of filesContent) {
      const { data } = await octokit.git.createBlob({
        owner: repoOwner,
        repo,
        content: file.content,
        encoding: "utf-8",
      });
      file[`sha`] = data.sha;
      debugFiles[file.relativePath] = file.sha;
    }

    core.debug(JSON.stringify(debugFiles));

    const tree: any[] = [];

    for (const file of filesContent) {
      tree.push({
        path: file.relativePath,
        mode: `100644`,
        type: `blob`,
        sha: file.sha,
      });
    }

    const { data } = await octokit.git.createTree({
      owner: repoOwner,
      repo,
      tree,
      base_tree: treeSha,
    });

    const newTreeSha = data.sha;

    core.debug(JSON.stringify({ createdTree: newTreeSha }));
    const { data: commitData } = await octokit.git.createCommit({
      owner: repoOwner,
      repo: repo,
      message: options.message,
      tree: newTreeSha,
      parents: [commitSha],
      author: {
        name: options.directPush ? serviceUserName : "github-actions[bot]",
        email: options.directPush
          ? serviceEmail
          : "2525789+github-actions[bot]@users.noreply.github.com",
      },
    });

    core.debug(JSON.stringify({ createdCommit: commitData.sha }));
    core.setOutput("commit", commitData.sha);

    await updateBranch(octokit, branch, commitData.sha, repoOwner, repo);

    core.debug(`Complete`);

    if (options.createPR && !options.directPush) {
      await createPullRequest(branch, options, octokit, repoOwner, repo);
    }
  } catch (e) {
    core.setFailed((e as Error).toString());
  }
};

export function replace(value: any, content: Record<string, any>) {
  let jsonPath = "spec.template.spec.containers.0.image";
  const copy = JSON.parse(JSON.stringify(content));

  if (!jsonPath.startsWith("$")) {
    jsonPath = `$.${jsonPath}`;
  }

  jsonPath = jsonPath.replace("[(@.length)]", "");

  jp.value(copy, jsonPath, value);

  return copy;
}

export const updateBranch = async (
  octo: Octokit,
  branch: string,
  commitSha: string,
  repoOwner: string,
  repo: string
): Promise<void> => {
  try {
    const data = await octo.git.updateRef({
      owner: repoOwner,
      repo,
      ref: `heads/${branch}`,
      sha: commitSha,
    });
  } catch (error) {
    core.info(
      `update branch ${branch} failed (${error}), fallback to create branch`
    );

    await octo.git
      .createRef({
        owner: repoOwner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: commitSha,
      })
      .catch((e) => core.setFailed(`failed to create branch: ${e}`));
  }
};

export const getCurrentCommit = async (
  octo: Octokit,
  branch: string,
  repoOwner: string,
  repo: string
): Promise<{ commitSha: string; treeSha: string }> => {
  let commitSha = "";
  try {
    const { data: refData } = await octo.git.getRef({
      owner: repoOwner,
      repo: repo,
      ref: `heads/${branch}`,
    });

    if (!refData.object?.sha) {
      throw Error(`Failed to get current ref from heads/${branch}`);
    }

    commitSha = refData.object?.sha;
  } catch (error) {
    const { data: refData } = await octo.git.getRef({
      owner: repoOwner,
      repo,
      ref: `heads/main`,
    });

    if (!refData.object?.sha) {
      throw Error(`Failed to get current ref from heads/master`);
    }

    commitSha = refData.object?.sha;
  }

  const { data: commitData } = await octo.git.getCommit({
    owner: repoOwner,
    repo,
    commit_sha: commitSha,
  });

  if (!commitData.tree?.sha) {
    throw Error("Failed to get the commit");
  }

  return {
    commitSha,
    treeSha: commitData.tree?.sha,
  };
};

export async function createPullRequest(
  branch: string,
  options: Options,
  octokit: Octokit,
  repoOwner: string,
  repo: string
): Promise<void> {
  const response = await octokit.pulls.create({
    owner: repoOwner,
    repo,
    title: options.title || `Merge: ${options.message}`,
    head: branch,
    base: options.targetBranch,
    body: options.description,
  });

  core.debug(`Create PR: #${response.data.id}`);

  core.setOutput("pull_request", JSON.stringify(response.data));

  octokit.issues.addLabels({
    owner: repoOwner,
    repo,
    issue_number: response.data.number,
    labels: options.labels.split(","),
  });

  core.debug(`Add Label: ${options.labels}`);
}

// run();

const services = "account-service, orderbook-service";
const environment = Environment.Sandbox;
const options = {
  createPR: true,
  token: "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",
  repo: "anki872198/CI-CD-Check-Branch",
  labels: "sandbox-tags",
  message: "something ",
  title: "something",
  description: "sdaf",
  mainBranch: "temp-check/gh-actions",
  syncWith: "development",
  branch: "staging",
  targetBranch: "temp-check/gh-actions",
  directPush: true,
};

updateAllImages(services, environment, options, "./src/example/");
