import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.8/+esm";

const SUPABASE_URL = "https://eewvtykkjnnfmwhhntgl.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_2mjKpNnMfugiM-7x_banfA_Q--qZmNr";
const PAGE_URL = "https://selchy24x.github.io/kizutsukanai-site/account-deletion/";
const STORAGE_KEY = "kizutsukanai-web-account-deletion";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: "implicit",
    detectSessionInUrl: true,
    persistSession: true,
    storageKey: `${STORAGE_KEY}-auth`,
  },
});

const state = {
  challenge: null,
  email: "",
  otpPurpose: "login",
  receipt: readJson(`${STORAGE_KEY}-receipt`),
  pollingTimer: null,
};

const views = [...document.querySelectorAll(".view")];
const message = document.querySelector("#global-message");
const emailForm = document.querySelector("#email-form");
const otpForm = document.querySelector("#otp-form");
const consent = document.querySelector("#deletion-consent");
const verifyDeletionButton = document.querySelector("#verify-deletion");
const warningDialog = document.querySelector("#irreversibility-dialog");

document.addEventListener("DOMContentLoaded", initialise);

async function initialise() {
  bindEvents();
  showInitialWarning();
  const socialResult = consumeSocialResult();

  if (state.receipt?.statusToken) {
    showView("progress-view");
    setProgress("削除処理が進行中です…", "処理が完了するまで、この画面でお待ちください。");
    await pollProgress();
    return;
  }

  const { data } = await supabase.auth.getSession();
  if (data.session) {
    if (window.location.search || window.location.hash) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    await prepareDeletion({ resumeReauthentication: socialResult.resumeReauthentication });
    if (socialResult.message) showMessage(socialResult.message);
  } else {
    showView("login-view");
    if (socialResult.message) showMessage(socialResult.message);
  }
}

function bindEvents() {
  emailForm.addEventListener("submit", sendLoginOtp);
  otpForm.addEventListener("submit", verifyOtp);
  document.querySelector("#resend-otp").addEventListener("click", resendOtp);

  for (const button of document.querySelectorAll("[data-provider]")) {
    button.addEventListener("click", () => beginSocialLogin(button.dataset.provider));
  }
  for (const button of document.querySelectorAll("[data-action]")) {
    button.addEventListener("click", () => handleAction(button.dataset.action));
  }

  consent.addEventListener("change", () => {
    verifyDeletionButton.disabled = !consent.checked;
  });
  verifyDeletionButton.addEventListener("click", beginDeletionVerification);
  document.querySelector("#reauth-social").addEventListener("click", beginSocialReauthentication);
  document.querySelector("#start-deletion").addEventListener("click", startDeletion);
  document.querySelector("#acknowledge-deletion").addEventListener("click", acknowledgeWarning);
  warningDialog.addEventListener("cancel", (event) => event.preventDefault());
}

function showInitialWarning() {
  const params = new URLSearchParams(window.location.search);
  const returningFromAuthentication = params.has("social_status") || Boolean(window.location.hash);
  if (state.receipt?.statusToken || returningFromAuthentication || warningDialog.open) return;
  warningDialog.showModal();
}

function acknowledgeWarning() {
  warningDialog.close();
  if (!document.querySelector("#login-view").hidden) {
    document.querySelector("#email").focus();
  }
}

async function sendLoginOtp(event) {
  event.preventDefault();
  clearMessage();
  const email = document.querySelector("#email").value.trim().toLowerCase();
  if (!isEmail(email)) {
    return showMessage("メールアドレスを正しく入力してください。");
  }

  setBusy(emailForm, true);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  setBusy(emailForm, false);
  if (error) return showMessage(normalizeAuthError(error));

  state.email = email;
  state.otpPurpose = "login";
  document.querySelector("#otp-description").textContent = `${maskEmail(email)} に届いた確認コードを入力してください。`;
  showView("otp-view");
}

async function verifyOtp(event) {
  event.preventDefault();
  clearMessage();
  const token = document.querySelector("#otp").value.trim();
  if (!/^\d{6,8}$/.test(token)) return showMessage("確認コードを入力してください。");

  setBusy(otpForm, true);
  const { error } = await supabase.auth.verifyOtp({
    email: state.email,
    token,
    type: "email",
  });
  setBusy(otpForm, false);
  if (error) return showMessage("確認コードが正しくないか、有効期限が切れています。");

  document.querySelector("#otp").value = "";
  if (state.otpPurpose === "login") {
    await prepareDeletion();
  } else {
    showDeletionReady();
  }
}

async function resendOtp() {
  clearMessage();
  const email = state.otpPurpose === "deletion" ? state.challenge?.email : state.email;
  if (!email) return showMessage("送信先を確認できませんでした。最初からやり直してください。");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) return showMessage(normalizeAuthError(error));
  showMessage("確認コードを再送しました。", "success");
}

async function beginSocialLogin(provider, { reauthentication = false } = {}) {
  clearMessage();
  const functionName = provider === "google"
    ? "web-account-deletion-google-start"
    : "social-auth-start";
  const body = provider === "google"
    ? {}
    : { provider, app_redirect_to: PAGE_URL, deletion_only: true };
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error || !data?.authorization_url) {
    return showMessage("SNSログインを開始できませんでした。時間をおいてお試しください。");
  }
  if (reauthentication) localStorage.setItem(`${STORAGE_KEY}-pending-reauth`, "true");
  window.location.assign(data.authorization_url);
}

async function prepareDeletion({ resumeReauthentication = false } = {}) {
  clearMessage();
  showView("progress-view");
  setProgress("アカウントを確認しています…", "削除前の条件を確認しています。");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name,email")
    .maybeSingle();

  const { data, error } = await supabase.functions.invoke("account-deletion-challenge", {
    body: { web_login: true },
  });
  if (error) {
    const details = await functionErrorDetails(error);
    if (functionStatus(error) === 409 && Array.isArray(details.blockers)) {
      return showBlockers(details.blockers);
    }
    return failToLogin("削除手続きを準備できませんでした。アカウントを確認して、もう一度お試しください。");
  }

  state.challenge = {
    id: data.challenge_id,
    method: data.verification_method,
    provider: data.provider,
    email: data.email,
    maskedEmail: data.masked_email,
    verificationSatisfied: data.verification_satisfied === true,
  };
  writeJson(`${STORAGE_KEY}-challenge`, state.challenge);

  const name = profile?.display_name?.trim() || "名称未設定のアカウント";
  const accountEmail = profile?.email?.endsWith("@social-auth.invalid") ? "SNSログインのアカウント" : profile?.email || "";
  document.querySelector("#account-name").textContent = name;
  document.querySelector("#account-email").textContent = accountEmail;
  document.querySelector("#account-initial").textContent = [...name][0] || "?";
  consent.checked = false;
  verifyDeletionButton.disabled = true;
  if (resumeReauthentication && state.challenge.verificationSatisfied) {
    showDeletionReady();
    return;
  }
  showView("confirm-view");
}

async function beginDeletionVerification() {
  if (!state.challenge || !consent.checked) return;
  clearMessage();
  if (state.challenge.verificationSatisfied) {
    showDeletionReady();
    return;
  }
  if (state.challenge.method === "email_otp") {
    state.email = state.challenge.email;
    state.otpPurpose = "deletion";
    const { error } = await supabase.auth.signInWithOtp({
      email: state.email,
      options: { shouldCreateUser: false },
    });
    if (error) return showMessage(normalizeAuthError(error));
    document.querySelector("#otp-description").textContent = `${state.challenge.maskedEmail || maskEmail(state.email)} に届いた確認コードを入力してください。`;
    showView("otp-view");
    return;
  }

  const provider = state.challenge.provider;
  document.querySelector("#reauth-description").textContent = `${providerLabel(provider)}でもう一度ログインし、削除するアカウントの本人確認を行ってください。`;
  const button = document.querySelector("#reauth-social");
  button.textContent = `${providerLabel(provider)}で再認証`;
  button.hidden = false;
  document.querySelector("#start-deletion").hidden = true;
  showView("reauth-view");
}

async function beginSocialReauthentication() {
  const provider = state.challenge?.provider;
  if (!provider) return showMessage("再認証方法を確認できませんでした。");
  localStorage.setItem(`${STORAGE_KEY}-pending-reauth`, "true");
  await beginSocialLogin(provider, { reauthentication: true });
}

function showDeletionReady() {
  document.querySelector("#reauth-description").textContent = "本人確認が完了しました。「削除する」を押すと削除処理を開始します。";
  document.querySelector("#reauth-social").hidden = true;
  document.querySelector("#start-deletion").hidden = false;
  showView("reauth-view");
}

async function startDeletion() {
  if (!state.challenge) return showMessage("削除手続きを確認できませんでした。最初からやり直してください。");
  clearMessage();
  showView("progress-view");
  setProgress("削除を開始しています…", "サーバーの受付を待っています。");

  const statusToken = randomToken();
  state.receipt = {
    requestId: state.challenge.id,
    statusToken,
    acceptedAt: new Date().toISOString(),
  };
  writeJson(`${STORAGE_KEY}-receipt`, state.receipt);

  const { data, error } = await supabase.functions.invoke("start-account-deletion", {
    body: { challenge_id: state.challenge.id, status_token: statusToken },
  });
  if (error) {
    clearReceipt();
    if (functionStatus(error) === 409) return await prepareDeletion();
    showView("reauth-view");
    return showMessage("削除を開始できませんでした。本人確認をやり直してください。");
  }

  state.receipt.requestId = data?.request_id || state.challenge.id;
  writeJson(`${STORAGE_KEY}-receipt`, state.receipt);
  setProgress("削除処理が進行中です…", "処理が完了するまで、この画面でお待ちください。");
  await pollProgress();
}

async function pollProgress() {
  if (!state.receipt?.statusToken) return;
  window.clearTimeout(state.pollingTimer);
  const { data, error } = await supabase.functions.invoke("account-deletion-status", {
    body: { status_token: state.receipt.statusToken },
  });

  if (!error && data?.status === "completed") {
    clearReceipt();
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    showView("complete-view");
    return;
  }
  if (error && functionStatus(error) === 404) {
    setProgress("削除状況を確認しています…", "通信状況を確認しながら再試行しています。");
  }
  state.pollingTimer = window.setTimeout(pollProgress, 3000);
}

function showBlockers(blockers) {
  const list = document.querySelector("#blocker-list");
  list.replaceChildren(...blockers.map((blocker) => {
    const item = document.createElement("li");
    item.textContent = `${blocker.circle_name || "サークル"}（自分以外 ${Number(blocker.other_member_count || 0)}人）`;
    return item;
  }));
  showView("blocker-view");
}

async function handleAction(action) {
  clearMessage();
  if (action === "back") return showView("login-view");
  if (action === "confirm") return showView("confirm-view");
  if (action === "retry") return await prepareDeletion();
  if (action === "signout") return await failToLogin();
}

async function failToLogin(errorMessage = "") {
  await supabase.auth.signOut({ scope: "local" }).catch(() => {});
  state.challenge = null;
  localStorage.removeItem(`${STORAGE_KEY}-challenge`);
  showView("login-view");
  if (errorMessage) showMessage(errorMessage);
}

function consumeSocialResult() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("social_status");
  const pendingReauthentication = localStorage.getItem(`${STORAGE_KEY}-pending-reauth`) === "true";
  localStorage.removeItem(`${STORAGE_KEY}-pending-reauth`);

  let resultMessage = "";
  if (status === "error") {
    resultMessage = params.get("message") || "SNSログインを完了できませんでした。";
  } else if (status === "cancelled") {
    resultMessage = "SNSログインをキャンセルしました。";
  }

  if (status && window.location.search) {
    window.history.replaceState({}, "", window.location.pathname + window.location.hash);
  }

  return {
    message: resultMessage,
    resumeReauthentication: pendingReauthentication && !resultMessage,
  };
}

function showView(id) {
  for (const view of views) view.hidden = view.id !== id;
  updateStepState(id);
  clearMessage();
  if (id !== "login-view" && id !== "progress-view") {
    document.querySelector(".auth-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function updateStepState(viewId) {
  const step = ["progress-view", "complete-view"].includes(viewId)
    ? 3
    : ["confirm-view", "reauth-view", "blocker-view"].includes(viewId)
      ? 2
      : 1;
  const steps = document.querySelector(".steps");
  steps.dataset.currentStep = String(step);
  for (const [index, item] of [...steps.querySelectorAll("li")].entries()) {
    if (index + 1 === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
}

function setProgress(title, description) {
  document.querySelector("#progress-title").textContent = title;
  document.querySelector("#progress-description").textContent = description;
}

function showMessage(text, type = "error") {
  message.textContent = text;
  message.className = `message ${type === "success" ? "success" : ""}`;
  message.hidden = false;
}

function clearMessage() {
  message.hidden = true;
  message.textContent = "";
}

function setBusy(form, busy) {
  for (const element of form.elements) element.disabled = busy;
}

function clearReceipt() {
  state.receipt = null;
  localStorage.removeItem(`${STORAGE_KEY}-receipt`);
  localStorage.removeItem(`${STORAGE_KEY}-challenge`);
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function maskEmail(email) {
  const [local = "", domain = ""] = email.split("@", 2);
  if (!domain) return email;
  return `${local.slice(0, Math.min(2, local.length))}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function providerLabel(provider) {
  return ({ google: "Google", line: "LINE", yahoo: "Yahoo! JAPAN ID" })[provider] || "SNS";
}

function normalizeAuthError(error) {
  const text = String(error?.message || "").toLowerCase();
  if (text.includes("rate") || text.includes("seconds")) return "少し時間をおいてから、もう一度お試しください。";
  return "ログインを開始できませんでした。入力内容を確認してください。";
}

function functionStatus(error) {
  return Number(error?.context?.status || error?.status || 0);
}

async function functionErrorDetails(error) {
  try {
    if (error?.context instanceof Response) {
      return await error.context.clone().json();
    }
  } catch {
    // Use an empty error body when the platform response cannot be decoded.
  }
  return {};
}
