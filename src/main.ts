import * as core from "@actions/core";
import { context } from "@actions/github";
import { Context } from "@actions/github/lib/context";
import { WebhookPayload } from "@actions/github/lib/interfaces";

import {
  pickupUsername,
  pickupInfoFromGithubPayload,
  GithubRepositoryImpl,
} from "./modules/github";
import {
  buildSlackPostMessage,
  buildSlackErrorMessage,
  SlackRepositoryImpl,
} from "./modules/slack";

export type AllInputs = {
  repoToken: string;
  configurationPath: string;
  slackWebhookUrl: string;
  debugFlag: boolean;
  iconUrl?: string;
  botName?: string;
  runId?: string;
};

export const convertToSlackUsername = async (
  githubUsernames: string[],
  githubClient: typeof GithubRepositoryImpl,
  repoToken: string,
  configurationPath: string,
  context: Pick<Context, "repo" | "sha">
): Promise<string[]> => {
  const mapping = await githubClient.loadNameMappingConfig(
    repoToken,
    context.repo.owner,
    context.repo.repo,
    configurationPath,
    context.sha
  );

  const slackIds = githubUsernames.map(
    (githubUsername) => {
    var slackId = mapping[githubUsername];
    return (slackId !== undefined)? slackId : githubUsername;
    }
  ) as string[];

  return slackIds;
};

export const markdownToSlackBody = async (
  markdown: string,
  githubClient: typeof GithubRepositoryImpl,
  repoToken: string,
  configurationPath: string,
  context: Pick<Context, "repo" | "sha">
): Promise<string> => {
  var slackbody = markdown;

  // It may look different in slack because it is a simple character comparison, not a pattern check.
  const mask = [
    ["##### ", ""], // h5
    ["#### ", ""], // h4
    ["### ", ""], // h3
    ["## ", ""], // h2
    ["# ", ""], // h1
    ["***", ""], // line
    ["**", ""], // bold
    ["* ", "● "], // unordered list
    ["- [ ] ", "- □ "], // check box
    ["- [x] ", "- ☑ "], // check box (checked)
//    ["_", ""], // italic
    ["*", ""], // italic
    ["> ", "| "] // blockquote
  ];

  mask.forEach(value => {
    slackbody = slackbody.split(value[0]).join(value[1]);
  })

  // to slackID on body
  const githubIds = pickupUsername(slackbody);
  if (githubIds.length > 0) {
    const slackIds = await convertToSlackUsername(
      githubIds,
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    githubIds.forEach((value, index) => {
      if (value != slackIds[index])
      slackbody = slackbody.split("@" + value).join("<@" + slackIds[index] + ">");
    })
  }
  // body to inline code
  slackbody = "```" + slackbody + "```";

  return slackbody;
};

// Pull Request
export const execPullRequestMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
  const pullRequestGithubUsername = payload.pull_request?.user?.login;
  console.log(pullRequestGithubUsername);
  if (!pullRequestGithubUsername) {
    throw new Error("Can not find pull requested user.");
  }

  const slackIds = await convertToSlackUsername(
    [pullRequestGithubUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const action = payload.action;
  const title = payload.pull_request?.title;
  const url = payload.pull_request?.html_url;
//  const pull_request_body = payload.pull_request?.body as string;
  const pull_request_body = payload.pull_request?.body ?? "" as string;
  const changed_files = payload.pull_request?.changed_files as number;
  const commits = payload.pull_request?.commits as number;
  const merged = payload.pull_request?.merged as boolean;
  const pull_request_number = payload.pull_request?.number as number;
  const pr_from = payload.pull_request?.head?.ref as string;
  const pr_into = payload.pull_request?.base?.ref as string;
// fixed for mobile app
  const prSlackUserId = (slackIds[0] == pullRequestGithubUsername) ? "@" + pullRequestGithubUsername : "<@" + slackIds[0] + ">";

  var message = "";
  if (action === "opened" || action === "edited") {
    const body = (pull_request_body.length > 0) ? pull_request_body : "No description provided.";
    var pr_info = ">";
    pr_info += ((changed_files > 1) ? "Changed files" : "Changed file") + " : " + changed_files.toString();
    pr_info += ", ";
    pr_info += ((commits > 1) ? "Commits" : "Commit") + " : " + commits.toString();
    const slackBody = await markdownToSlackBody(
      body,
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    message = `*${prSlackUserId} has ${action} PULL REQUEST into \`${pr_into}\` from \`${pr_from}\` <${url}|${title}> #${pull_request_number}*\n${pr_info}\n${slackBody}\n${url}`;
  }
  else if (action == "assigned" || action == "unassigned") {
    const targetGithubId = payload.assignee?.login as string;
    const slackIds = await convertToSlackUsername(
      [targetGithubId],
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    const slackBody = ">" + ((action == "assigned") ? "Added" : "Removed") + " : " + ((targetGithubId == slackIds[0]) ? "@" + targetGithubId : "<@" + slackIds[0] + ">");
    message = `*${prSlackUserId} has ${action} PULL REQUEST into \`${pr_into}\` from \`${pr_from}\` <${url}|${title}> #${pull_request_number}*\n${slackBody}\n${url}`;
  }
  else if (action == "closed") {
    if (merged == true) { // the pull request was merged.
      var pr_info = ">";
      pr_info += ((changed_files > 1) ? "Changed files" : "Changed file") + " : " + changed_files.toString();
      pr_info += ", ";
      pr_info += ((commits > 1) ? "Commits" : "Commit") + " : " + commits.toString();
      message = `*${prSlackUserId} has merged PULL REQUEST into \`${pr_into}\` from \`${pr_from}\` <${url}|${title}> #${pull_request_number}*\n${pr_info}\n${url}`;
    }
    else { // the pull request was closed with unmerged commits.
      message = `*${prSlackUserId} has ${action} PULL REQUEST with unmerged commits into \`${pr_into}\` from \`${pr_from}\` <${url}|${title}> #${pull_request_number}*\n${url}`;
    }
  }
  else {
    message = `*${prSlackUserId} has ${action} PULL REQUEST into \`${pr_into}\` from \`${pr_from}\` <${url}|${title}> #${pull_request_number}*\n${url}`;
  }

  console.log(message);
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

// PR comment mentions
export const execPrReviewRequestedCommentMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
  const commentGithubUsername = payload.comment?.user?.login as string;
  const pullRequestedGithubUsername = payload.issue?.user?.login as string;

  if (!commentGithubUsername) {
    throw new Error("Can not find comment user.");
  }
  if (!pullRequestedGithubUsername) {
    throw new Error("Can not find pull request user.");
  }

  const slackIds = await convertToSlackUsername(
    [commentGithubUsername, pullRequestedGithubUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const action = payload.action as string;
  const pr_title = payload.issue?.title as string;
  const pr_state = payload.issue?.state as string;
//  const comment_body = payload.comment?.body as string;
  var comment_body = payload.comment?.body as string;
  const comment_url = payload.comment?.html_url as string;
  const commentSlackUserId = (slackIds[0] == commentGithubUsername) ? "@" + commentGithubUsername : "<@" + slackIds[0] + ">";
  const pullRequestedSlackUserId = (slackIds[1] == pullRequestedGithubUsername) ? "@" + pullRequestedGithubUsername : "<@" + slackIds[1] + ">";

  // to slackID on comment
  const githubIds = pickupUsername(comment_body);
  if (githubIds.length > 0) {
    const slackIds = await convertToSlackUsername(
      githubIds,
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    githubIds.forEach((value, index) => {
      if (value != slackIds[index])
        comment_body = comment_body.split("@" + value).join("<@" + slackIds[index] + ">");
    })
  }

  // show comment text as quote text.
  const comment_lines = comment_body.split("\n")
  var comment_as_quote = "";
  comment_lines.forEach(line => {
    core.warning(line)
    comment_as_quote += (">" + line);
  })

  const message = `*${commentSlackUserId} has ${action} a COMMENT on a ${pr_state} PULL REQUEST, which created by ${pullRequestedSlackUserId} <${comment_url}|${pr_title}>*\n${comment_as_quote}\n${comment_url}`;
  core.warning(message)
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

// Review Requested
export const execPrReviewRequestedMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
  const requestedGithubUsername =
    payload.requested_reviewer?.login || payload.requested_team?.name;
    const requestUsername = payload.sender?.login;

  if (!requestedGithubUsername) {
    throw new Error("Can not find review requested user.");
  }
  if (!requestUsername) {
    throw new Error("Can not find review request user.");
  }

  const slackIds = await convertToSlackUsername(
    [requestedGithubUsername, requestUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const title = payload.pull_request?.title;
  const url = payload.pull_request?.html_url;
  const requestedSlackUserId = (slackIds[0] == requestedGithubUsername) ? "@" + requestedGithubUsername : "<@" + slackIds[0] + ">";
  const requestSlackUserId = (slackIds[1] == requestUsername) ? "@" + requestUsername : "<@" + slackIds[1] + ">";

  const message = `*${requestedSlackUserId} has been REQUESTED to REVIEW <${url}|${title}> by ${requestSlackUserId}*\n${url}`;
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

// pull_request_review
export const execPullRequestReviewMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
  const reviewerUsername = payload.review?.user?.login as string;
  const pullRequestUsername = payload.pull_request?.user?.login as string;

  if (!reviewerUsername) {
    throw new Error("Can not find review user.");
  }
  if (!pullRequestUsername) {
    throw new Error("Can not find pull request user.");
  }

  const slackIds = await convertToSlackUsername(
    [reviewerUsername, pullRequestUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const action = payload.action as string;
  const title = payload.pull_request?.title as string;
  const url = payload.pull_request?.html_url as string;
  const state = payload.pull_request?.state as string;
  const body = payload.review?.body as string;
  const review_url = payload.review?.html_url as string;
  const reviewerSlackUserId = (slackIds[0] == reviewerUsername) ? "@" + reviewerUsername : "<@" + slackIds[0] + ">";
  const pullRequestSlackUserId = (slackIds[1] == pullRequestUsername) ? "@" + pullRequestUsername : "<@" + slackIds[1] + ">";
  const cm_state = payload.review?.state as string;

  const slackBody = await markdownToSlackBody(
    body,
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  const message = (cm_state === "approved")?
    `*${reviewerSlackUserId} has approved PULL REQUEST <${url}|${title}>, which created by ${pullRequestSlackUserId}*\n${review_url}`
    :
    `*${reviewerSlackUserId} has ${action} a REVIEW on ${state} PULL REQUEST <${url}|${title}>, which created by ${pullRequestSlackUserId}*\n${slackBody}\n${review_url}`;
 
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

// pull_request_review_comment
export const execPullRequestReviewComment = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
  const reviewerCommentUsername = payload.comment?.user?.login as string;
  const pullRequestUsername = payload.pull_request?.user?.login as string;

  if (!reviewerCommentUsername) {
    throw new Error("Can not find review comment user.");
  }
  if (!pullRequestUsername) {
    throw new Error("Can not find pull request user.");
  }

  const slackIds = await convertToSlackUsername(
    [reviewerCommentUsername, pullRequestUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const action = payload.action as string;
  const title = payload.pull_request?.title as string;
  const url = payload.pull_request?.html_url as string;
  const state = payload.pull_request?.state as string;
  const body = payload.comment?.body as string;
  const changeFilePath = payload.comment?.path as string;
  const diffHunk = payload.comment?.diff_hunk as string;
  const comment_url = payload.comment?.html_url as string;
  const reviewCommentSlackUserId = (slackIds[0] == reviewerCommentUsername) ? "@" + reviewerCommentUsername : "<@" + slackIds[0] + ">";;
  const pullRequestSlackUserId = (slackIds[1] == pullRequestUsername) ? "@" + pullRequestUsername : "<@" + slackIds[1] + ">";;

  const message = `*${reviewCommentSlackUserId} has ${action} a COMMENT REVIEW on ${state} PULL REQUEST <${url}|${title}>, which created by ${pullRequestSlackUserId}*\n \n\`\`\`${changeFilePath}\n${diffHunk}\`\`\`\n${body}\n${comment_url}`;
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

// Issue metion
export const execIssueMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
//  const issueGithubUsername = payload.issue?.user?.login as string;
  const issueGithubUsername = payload.sender?.login as string;

  if (!{issueGithubUsername}) {
    throw new Error("Can not find issue user.");
  }

  const slackIds = await convertToSlackUsername(
    [issueGithubUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const action = payload.action as string;
  const issue_title = payload.issue?.title as string;
  // const issue_state = payload.issue?.state as string;
  const issue_body = payload.issue?.body as string;
  const issue_number = payload.issue?.number as number;
  const issue_url = payload.issue?.html_url as string;
  const issueSlackUserId = (slackIds[0] == issueGithubUsername) ? "@" + issueGithubUsername : "<@" + slackIds[0] + ">";

  var message = "";

  if (action === "opened" || action === "edited") {
    const slackBody = await markdownToSlackBody(
      issue_body,
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    message = `*${issueSlackUserId} has ${action} an ISSUE <${issue_url}|${issue_title}> #${issue_number}*\n${slackBody}\n${issue_url}`;
  }
  else if (action == "assigned" || action == "unassigned") {
    const targetGithubId = payload.assignee?.login as string;
    const slackIds = await convertToSlackUsername(
      [targetGithubId],
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    const slackBody = ">" + ((action == "assigned") ? "Added" : "Removed") + " : " + ((targetGithubId == slackIds[0]) ? "@" + targetGithubId : "<@" + slackIds[0] + ">");
    message = `*${issueSlackUserId} has ${action} an ISSUE <${issue_url}|${issue_title}>* #${issue_number}\n${slackBody}\n${issue_url}`;
  }
  else {
    message = `*${issueSlackUserId} has ${action} an ISSUE <${issue_url}|${issue_title}>* #${issue_number}\n${issue_url}`;
  }

  core.warning(message)
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

// Issue comment mentions
export const execIssueCommentMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const { repoToken, configurationPath } = allInputs;
  const commentGithubUsername = payload.comment?.user?.login as string;
  const issueGithubUsername = payload.issue?.user?.login as string;

  if (!{commentGithubUsername}) {
    throw new Error("Can not find comment user.");
  }
  if (!{issueGithubUsername}) {
    throw new Error("Can not find issue user.");
  }

  const slackIds = await convertToSlackUsername(
    [commentGithubUsername, issueGithubUsername],
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const action = payload.action as string;
  const issue_title = payload.issue?.title as string;
  const issue_state = payload.issue?.state as string;
  const issue_url = payload.issue?.html_url as string;
  const issue_number = payload.issue?.number as number;
//  const comment_body = payload.comment?.body as string;
  var comment_body = payload.comment?.body as string;
  const comment_url = payload.comment?.html_url as string;
  const commentSlackUserId = (slackIds[0] == commentGithubUsername) ? "@" + commentGithubUsername : "<@" + slackIds[0] + ">";
  const issueSlackUserId = (slackIds[1] == issueGithubUsername) ? "@" + issueGithubUsername : "<@" + slackIds[1] + ">";

  // to slackID on comment
  const githubIds = pickupUsername(comment_body);
  if (githubIds.length > 0) {
    const slackIds = await convertToSlackUsername(
      githubIds,
      githubClient,
      repoToken,
      configurationPath,
      context
    );
    githubIds.forEach((value, index) => {
      if (value != slackIds[index])
        comment_body = comment_body.split("@" + value).join("<@" + slackIds[index] + ">");
    })
  }

  // show comment text as quote text.
  const comment_lines = comment_body.split("\n")
  var comment_as_quote = "";
  comment_lines.forEach(line => {
    core.warning(line)
    comment_as_quote += (">" + line);
  })

  const message = `*${commentSlackUserId} has ${action} a COMMENT on a ${issue_state} ISSUE <${issue_url}|${issue_title}> #${issue_number}, which created by ${issueSlackUserId}*\n${comment_as_quote}\n${comment_url}`;
  core.warning(message)
  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

export const execNormalMention = async (
  payload: WebhookPayload,
  allInputs: AllInputs,
  githubClient: typeof GithubRepositoryImpl,
  slackClient: typeof SlackRepositoryImpl,
  context: Pick<Context, "repo" | "sha">
): Promise<void> => {
  const info = pickupInfoFromGithubPayload(payload);

  if (info.body === null) {
    return;
  }

  const githubUsernames = pickupUsername(info.body);
  if (githubUsernames.length === 0) {
    return;
  }

  const { repoToken, configurationPath } = allInputs;
  const slackIds = await convertToSlackUsername(
    githubUsernames,
    githubClient,
    repoToken,
    configurationPath,
    context
  );

  if (slackIds.length === 0) {
    return;
  }

  const message = buildSlackPostMessage(
    slackIds,
    info.title,
    info.url,
    info.body,
    info.senderName
  );

  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

const buildCurrentJobUrl = (runId: string) => {
  const { owner, repo } = context.repo;
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
};

export const execPostError = async (
  error: Error,
  allInputs: AllInputs,
  slackClient: typeof SlackRepositoryImpl
): Promise<void> => {
  const { runId } = allInputs;
  const currentJobUrl = runId ? buildCurrentJobUrl(runId) : undefined;
  const message = buildSlackErrorMessage(error, currentJobUrl);

  core.warning(message);

  const { slackWebhookUrl, iconUrl, botName } = allInputs;

  await slackClient.postToSlack(slackWebhookUrl, message, { iconUrl, botName });
};

const getAllInputs = (): AllInputs => {
  const slackWebhookUrl = core.getInput("slack-webhook-url", {
    required: true,
  });

  if (!slackWebhookUrl) {
    core.setFailed("Error! Need to set `slack-webhook-url`.");
  }

  const repoToken = core.getInput("repo-token", { required: true });
  if (!repoToken) {
    core.setFailed("Error! Need to set `repo-token`.");
  }

  const debugFlagString = core.getInput("debug-flag", { required: false})
  var debugFlag = false
  if (!debugFlagString) {
    core.warning("Set debugFlag as false by default.");
    debugFlag = false;
  }
  else if (debugFlagString === "true") {
    core.warning("Set debugFlag as true.");
    debugFlag = true;
  } else if (debugFlagString === "false")  {
    core.warning("Set debugFlag as false.");
    debugFlag = false;
  } else {
    core.setFailed("Unknown input. You should set true or false for a debug flag.")
  }
  // always set debugFlagString as true
  debugFlag = true

  const iconUrl = core.getInput("icon-url", { required: false });
  const botName = core.getInput("bot-name", { required: false });
  const configurationPath = core.getInput("configuration-path", {
    required: true,
  });
  const runId = core.getInput("run-id", { required: false });

  return {
    repoToken,
    configurationPath,
    slackWebhookUrl,
    debugFlag,
    iconUrl,
    botName,
    runId,
  };
};

export const main = async (): Promise<void> => {
  const { payload } = context;
  const allInputs = getAllInputs();

  try {
    if (allInputs.debugFlag) {
      const message2 = `eventName is <${context.eventName}>.`;
      console.log(message2);
      const message3 = `action is <${context.action}>.`;
      console.log(message3);
      const message4 = `actor is <${context.actor}>.`;
      console.log(message4);
      const message5 = `issue is <${payload.issue?.pull_request}>.`;
      console.log(message5);
    }

    if (payload.action === "review_requested") {
      if (allInputs.debugFlag) core.warning("This action is a review requested.")
      await execPrReviewRequestedMention(
        payload,
        allInputs,
        GithubRepositoryImpl,
        SlackRepositoryImpl,
        context
      );
      if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
      return;
    }
    
    if (context.eventName === "pull_request") {
      if (allInputs.debugFlag) core.warning("This action is a pull request.")
      await execPullRequestMention(
        payload,
        allInputs,
        GithubRepositoryImpl,
        SlackRepositoryImpl,
        context
      );
      if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
      return;
    }

    if (context.eventName === "issue_comment") {
      if (payload.issue?.pull_request == undefined) {
        if (allInputs.debugFlag) core.warning("This comment is on an Issue.")
        await execIssueCommentMention(
          payload,
          allInputs,
          GithubRepositoryImpl,
          SlackRepositoryImpl,
          context
        );
        if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
        return;
      }
      else {
        if (allInputs.debugFlag) core.warning("This comment is on a pull request.")
        await execPrReviewRequestedCommentMention(
          payload,
          allInputs,
          GithubRepositoryImpl,
          SlackRepositoryImpl,
          context
        );
        if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
        return;
      }
      // throw new Error("Can not resolve this issue_comment.")
    }

    if (context.eventName === "issues") {
      await execIssueMention(
        payload,
        allInputs,
        GithubRepositoryImpl,
        SlackRepositoryImpl,
        context
      );
      if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
      return;
    }

    if (context.eventName === "pull_request_review") {
      await execPullRequestReviewMention(
        payload,
        allInputs,
        GithubRepositoryImpl,
        SlackRepositoryImpl,
        context
      );
      if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
      return;
    }

    if (context.eventName === "pull_request_review_comment") {
      await execPullRequestReviewComment(
        payload,
        allInputs,
        GithubRepositoryImpl,
        SlackRepositoryImpl,
        context
      );
      if (allInputs.debugFlag) {core.warning(JSON.stringify({ payload }));}
      return;
    }

    // await execNormalMention(
    //   payload,
    //   allInputs,
    //   GithubRepositoryImpl,
    //   SlackRepositoryImpl,
    //   context
    // );
    throw new Error("Unexpected event.");
  } catch (error) {
    await execPostError(error, allInputs, SlackRepositoryImpl);
    core.warning(JSON.stringify({ payload }));
  }
};
