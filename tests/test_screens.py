"""End-to-end screen tests for cat.

Covers every screen the application has: the sign-in gate, the gate's refusal
of an address that is not on the allowlist, the signed-in workspace, posting,
message rendering, and the agent hint in the composer.

Two things make this awkward to automate, and both are handled here:

  * There is no password to type. Sign-in is by magic link, so the suite mints
    one through Supabase's admin API and drives the browser to it -- the same
    mechanism as tools/magic-link.sh.

  * The tests run against the real project, because that is the only database
    there is. Everything written is tagged with a marker and deleted afterwards.

Invoking the agent costs money, so that test is opt-in. By default the suite
asserts only that the composer offers the agent; with CAT_TEST_AGENT=1 it does
the full round trip and waits for a real answer.

Usage:

    export SUPABASE_SERVICE_ROLE_KEY='...'     # Project Settings -> API Keys
    python3 tests/test_screens.py -v           # everything except the agent

    CAT_TEST_AGENT=1 python3 tests/test_screens.py -v   # include the agent
    HEADED=1 python3 tests/test_screens.py              # watch it run

Note the interpreter: use the python3 that has selenium installed
(/opt/homebrew/bin/python3 here), not whichever one PATH resolves first.
"""

import json
import os
import re
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
SHOTS = Path(__file__).resolve().parent / "screenshots"

BASE_URL = os.environ.get("CAT_BASE_URL", "http://localhost:8000")
TEST_EMAIL = os.environ.get("CAT_TEST_EMAIL", "metaphorz@gmail.com")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

# Every message this suite writes carries this marker so cleanup can find them
# again without guessing.
MARKER = "cat-selenium-fixture"

# Agent replies carry no marker -- the agent writes them, not us -- so they are
# identified for cleanup by having arrived after the run began.
RUN_STARTED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

# How long to let the agent think before calling it a failure. An Opus call
# with repo context and high effort is comfortably slower than a page load.
AGENT_TIMEOUT = 180


def read_config():
    """Take the Supabase URL and anon key from config.js.

    Reading them rather than repeating them keeps the tests honest: point
    config.js at a different project and the tests follow it.
    """
    text = (ROOT / "config.js").read_text(encoding="utf-8")
    url = re.search(r'supabaseUrl:\s*"([^"]+)"', text)
    key = re.search(r'supabaseAnonKey:\s*"([^"]+)"', text)
    if not url or not key:
        raise RuntimeError("Could not parse config.js")
    return url.group(1).rstrip("/"), key.group(1)


SUPABASE_URL, ANON_KEY = read_config()


def admin_request(method, path, body=None, headers=None):
    """Call Supabase as the service role. Used only for setup and teardown."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)

    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw.strip() else None


def mint_signin_link(email):
    """A single-use sign-in URL, without involving email at all."""
    result = admin_request(
        "POST",
        "/auth/v1/admin/generate_link",
        {"type": "magiclink", "email": email, "redirect_to": BASE_URL},
    )
    link = (result or {}).get("properties", {}).get("action_link")
    if not link:
        raise RuntimeError(f"No action_link in response: {result}")
    return link


def delete_fixture_messages():
    quoted = urllib.parse.quote(f"*{MARKER}*")
    filters = [
        # What we posted.
        f"/rest/v1/messages?body=like.{quoted}",
        # What the agent said back, if the agent test ran.
        f"/rest/v1/messages?agent_slug=not.is.null&created_at=gt.{RUN_STARTED_AT}",
    ]
    for f in filters:
        try:
            admin_request("DELETE", f, headers={"Prefer": "return=minimal"})
        except urllib.error.HTTPError as exc:
            print(f"cleanup warning: {exc}")


def make_driver():
    options = Options()
    if not os.environ.get("HEADED"):
        options.add_argument("--headless=new")
    options.add_argument("--window-size=1280,900")
    # A clean profile every run, so no session leaks between runs.
    options.add_argument("--incognito")
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(30)
    return driver


def shoot(driver, name):
    SHOTS.mkdir(exist_ok=True)
    driver.save_screenshot(str(SHOTS / f"{name}.png"))


class ScreenTest(unittest.TestCase):
    """Shared helpers."""

    driver = None

    def wait(self, timeout=20):
        return WebDriverWait(self.driver, timeout)

    def visible(self, css, timeout=20):
        return self.wait(timeout).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, css))
        )

    def text_of(self, css):
        return self.driver.find_element(By.CSS_SELECTOR, css).text


class TestGate(ScreenTest):
    """The signed-out screen, and the allowlist boundary."""

    @classmethod
    def setUpClass(cls):
        cls.driver = make_driver()

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()

    def setUp(self):
        self.driver.get(BASE_URL)
        self.visible("#gate")

    def test_01_gate_renders(self):
        self.assertTrue(self.driver.find_element(By.ID, "email").is_displayed())
        self.assertIn("sign-in link", self.text_of("#signin-btn").lower())
        self.assertIn("invitation", self.text_of(".fine").lower())
        shoot(self.driver, "01-gate")

    def test_02_gate_has_no_password_field(self):
        """Magic-link auth means there is nothing password-shaped anywhere."""
        self.assertEqual(
            self.driver.find_elements(By.CSS_SELECTOR, "input[type=password]"), []
        )

    def test_03_workspace_hidden_while_signed_out(self):
        self.assertFalse(self.driver.find_element(By.ID, "app").is_displayed())

    def test_04_unknown_email_is_refused(self):
        """An address that is not on the allowlist must not get in.

        The visible outcome varies -- Supabase may return an explicit error or
        stay silent to avoid confirming whether an address exists -- so the
        assertion is on the property that actually matters: no workspace.
        """
        self.driver.find_element(By.ID, "email").send_keys("nobody@example.invalid")
        self.driver.find_element(By.ID, "signin-btn").click()

        # Give the request time to complete and any state change to land.
        self.wait().until(
            lambda d: d.find_element(By.ID, "gate-msg").text.strip() != ""
        )
        time.sleep(1)

        self.assertTrue(self.driver.find_element(By.ID, "gate").is_displayed())
        self.assertFalse(self.driver.find_element(By.ID, "app").is_displayed())
        shoot(self.driver, "02-gate-refused")


@unittest.skipUnless(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY is not set")
class TestWorkspace(ScreenTest):
    """Everything behind the sign-in wall."""

    @classmethod
    def setUpClass(cls):
        cls.driver = make_driver()
        cls.driver.get(mint_signin_link(TEST_EMAIL))
        WebDriverWait(cls.driver, 30).until(
            EC.visibility_of_element_located((By.ID, "app"))
        )

    @classmethod
    def tearDownClass(cls):
        delete_fixture_messages()
        cls.driver.quit()

    def post(self, body):
        box = self.driver.find_element(By.ID, "input")
        box.clear()
        box.send_keys(body)
        self.driver.find_element(By.ID, "send").click()
        self.wait().until(
            lambda d: any(
                body.splitlines()[0][:30] in el.text
                for el in d.find_elements(By.CSS_SELECTOR, ".msg-row .text")
            )
        )

    def test_01_sidebar(self):
        self.assertIn("cat", self.text_of(".brand"))
        # The mark is drawn, not an emoji, so it should be a real SVG.
        self.assertTrue(
            self.driver.find_element(By.CSS_SELECTOR, "svg.brand-mark").is_displayed()
        )
        self.assertIn("# multimodel", self.text_of("#channels"))
        self.assertIn("@claude", self.text_of("#agents"))
        shoot(self.driver, "03-workspace")

    def test_02_people_grouped_by_specialty(self):
        people = self.text_of("#people")
        self.assertIn("Paul", people)
        self.assertIn("@paul", people)
        # The group heading comes from the specialties table.
        self.assertIn("Modeling and simulation", people.lower().title())

    def test_03_agent_permission_badge(self):
        badge = self.driver.find_element(By.ID, "me-badge")
        self.assertTrue(badge.is_displayed(), "Paul should be able to invoke agents")
        self.assertIn("invoke", badge.text.lower())

    def test_04_channel_header_points_at_the_repo(self):
        self.assertIn("multimodel", self.text_of("#channel-name"))
        repo = self.driver.find_element(By.ID, "channel-repo")
        self.assertTrue(repo.is_displayed())
        self.assertIn("metaphorz/Multimodel", repo.get_attribute("href"))

    def test_05_posting_a_message(self):
        body = f"{MARKER} plain message"
        self.post(body)

        row = self.driver.find_elements(By.CSS_SELECTOR, ".msg-row")[-1]
        self.assertIn("Paul", row.text)
        self.assertIn(MARKER, row.text)
        shoot(self.driver, "04-message-posted")

    def test_06_code_blocks_render(self):
        self.post(f"{MARKER} code\n\n```python\nrmax = f(cp)\n```")
        blocks = self.driver.find_elements(By.CSS_SELECTOR, ".text pre code")
        self.assertTrue(blocks, "fenced code should render as <pre><code>")
        self.assertIn("rmax", blocks[-1].text)

    def test_07_markup_in_messages_is_escaped(self):
        self.post(f"{MARKER} <img src=x onerror=alert(1)>")
        # If escaping failed the tag would become a real element rather than text.
        self.assertEqual(
            self.driver.find_elements(By.CSS_SELECTOR, ".text img"),
            [],
            "message content must never become live markup",
        )

    def test_08_composer_offers_the_agent(self):
        """Typing @claude should advertise it -- without actually invoking it."""
        box = self.driver.find_element(By.ID, "input")
        box.clear()
        box.send_keys("@claude are you there")
        self.wait().until(
            lambda d: "will reply" in d.find_element(By.ID, "hint").text.lower()
        )
        shoot(self.driver, "05-agent-hint")
        box.clear()


    @unittest.skipUnless(
        os.environ.get("CAT_TEST_AGENT"),
        "set CAT_TEST_AGENT=1 -- this one calls the Anthropic API and is billed",
    )
    def test_09_invoking_the_agent(self):
        """The full round trip: mention, placeholder, real answer.

        Off by default because every run costs money. It is the only test that
        needs the edge function deployed, so a failure here means the function,
        its secrets, or the permission check -- not the front end.
        """
        before = len(self.driver.find_elements(By.CSS_SELECTOR, ".msg-row.by-agent"))

        self.post(f"{MARKER} @claude reply with exactly the word: pong")

        # The placeholder should appear almost at once -- the function inserts
        # it and returns before the model has said anything.
        self.wait(30).until(
            lambda d: len(d.find_elements(By.CSS_SELECTOR, ".msg-row.by-agent")) > before,
            "no agent placeholder appeared -- is invoke-agent deployed?",
        )
        shoot(self.driver, "06-agent-thinking")

        # Then it fills in. Realtime delivers the update; no reload involved.
        def answered(d):
            rows = d.find_elements(By.CSS_SELECTOR, ".msg-row.by-agent")
            if len(rows) <= before:
                return False
            text = rows[-1].find_element(By.CSS_SELECTOR, ".text")
            return "thinking" not in (text.get_attribute("class") or "")

        try:
            self.wait(AGENT_TIMEOUT).until(answered)
        except TimeoutException:
            self.fail(
                f"agent did not answer within {AGENT_TIMEOUT}s -- check the "
                f"function logs: supabase functions logs invoke-agent"
            )

        row = self.driver.find_elements(By.CSS_SELECTOR, ".msg-row.by-agent")[-1]
        body = row.find_element(By.CSS_SELECTOR, ".text")
        self.assertNotIn(
            "errored",
            body.get_attribute("class") or "",
            f"the agent returned an error: {body.text}",
        )
        self.assertTrue(body.text.strip(), "agent replied with nothing")
        shoot(self.driver, "07-agent-replied")
        print(f"\n    agent said: {body.text.strip()[:200]}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
