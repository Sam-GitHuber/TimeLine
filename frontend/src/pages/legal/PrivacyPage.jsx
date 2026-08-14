import { LegalPage, Section, P, UL } from "./LegalLayout.jsx";

// Privacy Policy. Written for UK GDPR / Data Protection Act 2018, proportionate
// to a self-hosted, invite-only, non-commercial family beta. Single source of
// truth for the privacy text; rendered here, linked from sign-up and the footer.
//
// NOTE: good-faith plain-English draft, not legal advice — worth a solicitor's
// review before any broader launch (see docs/SHARED.md).
const CONTACT = "timeline.support@icloud.com";

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="14 August 2026">
      <Section heading="Who we are">
        <P>
          TimeLine is a private, invite-only social timeline operated by an
          individual as a non-commercial project. For the purposes of UK data
          protection law (UK GDPR and the Data Protection Act 2018), the operator
          is the “data controller” for your personal data. You can contact us at{" "}
          <a href={`mailto:${CONTACT}`} className="text-accent-deep hover:underline">
            {CONTACT}
          </a>
          .
        </P>
        <P>
          Our approach is privacy-first by design: no advertising, no selling of
          data, no third-party analytics or tracking, and no algorithmic profiling
          of your activity.
        </P>
      </Section>

      <Section heading="What we collect">
        <UL>
          <li>
            <strong>Account details</strong> — your email address, your name, a
            securely hashed password, and an optional avatar and short bio.
          </li>
          <li>
            <strong>Your content</strong> — the posts, photos, comments and
            messages you create, and the groups you belong to.
          </li>
          <li>
            <strong>A record of consent</strong> — the date and time you accepted
            these terms and this policy at sign-up.
          </li>
          <li>
            <strong>Technical logs</strong> — our server keeps short-lived access
            logs (such as IP address, timestamp and the request made) to keep the
            Service secure and working. We don’t use these to profile you.
          </li>
        </UL>
        <P>
          When you upload a photo, we automatically strip embedded metadata
          (including any EXIF/GPS location) before storing it, so hidden location
          data in your photos isn’t shared.
        </P>
      </Section>

      <Section heading="Why we use it, and our legal basis">
        <UL>
          <li>
            To provide the Service — show your timeline, deliver your posts and
            messages to the people you’ve shared them with, and manage your
            account. Legal basis: <em>performance of a contract</em> with you (our
            terms).
          </li>
          <li>
            To keep the Service secure and reliable (e.g. server logs, abuse
            handling). Legal basis: our <em>legitimate interests</em> in running a
            safe service.
          </li>
          <li>
            To record that you agreed to our terms. Legal basis:{" "}
            <em>consent</em> and our <em>legal obligations</em> as a controller.
          </li>
        </UL>
      </Section>

      <Section heading="Who can see your data">
        <P>
          Your content is visible only to the people you share it with — the
          connections you’ve accepted and the members of any group you post into.
          It is not public, not indexed by search engines, and not shared with
          advertisers or data brokers.
        </P>
        <P>
          The operator, as administrator, can technically access data on the
          server (including messages, which are stored in plain text and are not
          end-to-end encrypted) in order to run and moderate the Service. We only
          do so where necessary — for example to act on a report or fix a problem.
        </P>
      </Section>

      <Section heading="Where your data is stored">
        <P>
          The Service runs on a single rented server in London, United Kingdom
          (Amazon Web Services). To protect against data loss, we take regular
          backups which are{" "}
          <strong>encrypted before they leave the server</strong> and stored with
          a cloud storage provider (Cloudflare). Backups are only ever held in
          encrypted form; the provider cannot read their contents.
        </P>
      </Section>

      <Section heading="Push notifications">
        <P>
          If you use our phone app and allow notifications, we send you alerts
          about things like new messages and replies. Getting a notification onto
          your phone means passing it through two companies we don’t control:{" "}
          <strong>Expo</strong>, and then <strong>Apple</strong> (on iPhone) or{" "}
          <strong>Google</strong> (on Android). These are US-based companies, so
          the little that a notification carries — described below — is
          transferred outside the UK. Nothing else about your account or your
          content leaves the London server described above, other than the
          encrypted backups.
        </P>
        <P>
          Because of that, we deliberately keep notifications almost empty. A
          notification says who it’s from — “New message from Ada” — and which
          conversation it belongs to, so that tapping it opens the right screen.{" "}
          <strong>
            The words of your messages, posts and comments are never put inside a
            notification
          </strong>
          , so they are never handed to those companies.
        </P>
        <P>
          On iPhone, the app then shows what a message says as well. It does this
          without putting the text in the notification: your phone fetches it from
          us directly, over an encrypted connection, after the notification has
          already arrived. To make that possible your phone stores a limited
          access key, which can only be used to fetch these previews and nothing
          else, and which is removed when you sign out.
        </P>
        <P>
          You can turn this off per device, under{" "}
          <strong>Message previews</strong> in the app’s settings. With it off,
          notifications from that device say only that something has arrived —
          not who it’s from and not what it says — and nothing is fetched. Your
          phone also decides separately whether to reveal a notification’s
          contents on the lock screen before you unlock it; on iPhone that’s{" "}
          <em>Show Previews</em>, in the Settings app under Notifications, and it
          applies to every app.
        </P>
        <P>
          Two things about that are worth stating plainly. While previews are on,
          anyone who can see your unlocked screen can read your messages. And because
          your phone has to be able to fetch a preview while it is locked in your
          pocket, that access key is stored so that it can be read once the phone
          has been unlocked at least once since being switched on — a slightly
          weaker protection than the one used for your login, which is readable
          only while the phone is actually unlocked. The key never leaves the
          device, and is not included in backups or synced to iCloud.
        </P>
        <P>
          You can stop notifications entirely at any time, either in your phone’s
          own settings or by signing out, and you can choose which kinds you
          receive in the app’s settings.
        </P>
      </Section>

      <Section heading="How long we keep it">
        <P>
          We keep your data for as long as your account is open. When you delete
          your account, your account and content are removed from the live Service
          promptly. Copies may remain in our encrypted backups for a short period
          (up to about 30 days) until those backups age out and are overwritten.
        </P>
      </Section>

      <Section heading="Your rights">
        <P>Under UK data protection law you have the right to:</P>
        <UL>
          <li>access the personal data we hold about you;</li>
          <li>have inaccurate data corrected;</li>
          <li>
            have your data erased — you can delete your account yourself from
            Settings at any time, or ask us to do it;
          </li>
          <li>restrict or object to certain processing; and</li>
          <li>ask for a copy of your data in a portable format.</li>
        </UL>
        <P>
          To exercise any of these, email{" "}
          <a href={`mailto:${CONTACT}`} className="text-accent-deep hover:underline">
            {CONTACT}
          </a>
          . If you’re unhappy with how we handle your data, you can complain to
          the UK Information Commissioner’s Office (ICO) at ico.org.uk.
        </P>
      </Section>

      <Section heading="Cookies">
        <P>
          We use only the essential cookies needed to keep you logged in securely
          (a session/authentication cookie and a cross-site-request-forgery token).
          We don’t use advertising or analytics cookies.
        </P>
      </Section>

      <Section heading="Children">
        <P>
          The Service is intended for adults (18+). It isn’t directed at children,
          and we don’t knowingly collect data from them.
        </P>
      </Section>

      <Section heading="Changes to this policy">
        <P>
          We may update this policy as the Service develops. If we make a
          significant change we’ll take reasonable steps to let members know.
        </P>
      </Section>
    </LegalPage>
  );
}
