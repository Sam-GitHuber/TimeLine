import { LegalPage, Section, P, UL } from "./LegalLayout.jsx";

// Terms of Service. Plain-language, proportionate to a private, invite-only,
// non-commercial family/friends beta run by an individual in the UK. Written for
// England & Wales governing law. This is the single source of truth for the ToS
// text; it's rendered here and linked from sign-up and the app footer.
//
// NOTE: this is a good-faith plain-English draft, not legal advice. Before any
// broader / public launch it's worth a solicitor's review (see docs/SHARED.md).
const CONTACT = "samejefford@gmail.com";

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="11 July 2026">
      <Section heading="1. About these terms">
        <P>
          TimeLine (“the Service”) is a small, private, invite-only social
          timeline operated by an individual (“we”, “us”, “the operator”) as a
          non-commercial project for friends and family. By creating an account
          or using the Service you agree to these terms. If you don’t agree,
          please don’t use the Service.
        </P>
        <P>
          The Service is currently a beta: it’s a work in progress, provided free
          of charge, and things may change or break. There are no ads, no
          tracking-for-profit, and no algorithmic ranking — your timeline is
          always shown newest-first.
        </P>
      </Section>

      <Section heading="2. Who can use it">
        <P>
          The Service is available by invitation only. You must be 18 or older to
          hold an account. You’re responsible for keeping your password safe and
          for everything done through your account. Don’t share your login or let
          someone else use your account.
        </P>
      </Section>

      <Section heading="3. Your content and who owns it">
        <P>
          You keep ownership of everything you post — your photos, text, comments
          and messages (“your content”). We don’t claim to own it.
        </P>
        <P>
          To actually run the Service, you give us a limited, non-exclusive,
          royalty-free licence to store, copy, back up and display your content —
          only to you and the specific people you’ve shared it with (your
          connections, or the members of a group you post into), and only for the
          purpose of operating the Service. This licence ends when you delete the
          content or your account, except for copies held briefly in encrypted
          backups (see the Privacy Policy).
        </P>
      </Section>

      <Section heading="4. What you promise about what you post">
        <P>By posting content, you confirm that:</P>
        <UL>
          <li>
            you own it or otherwise have the right to post and share it (for
            example, you took the photo, or you have the permission you need);
          </li>
          <li>
            sharing it here doesn’t infringe anyone else’s copyright, privacy or
            other rights; and
          </li>
          <li>
            you’ll be thoughtful about posting photos or information about other
            people — especially anyone who isn’t a member and can’t speak for
            themselves.
          </li>
        </UL>
      </Section>

      <Section heading="5. Things you must not do">
        <UL>
          <li>Post unlawful, infringing, hateful, harassing or abusive content.</li>
          <li>Upload anything containing malware, or try to break, overload or gain unauthorised access to the Service.</li>
          <li>Use the Service to harass, impersonate or deceive other members.</li>
          <li>Scrape, resell or redistribute other members’ content.</li>
        </UL>
        <P>
          We may remove content and suspend or close accounts that break these
          terms, to protect members and comply with the law.
        </P>
      </Section>

      <Section heading="6. Reporting content">
        <P>
          If you believe something on the Service infringes your rights or
          shouldn’t be here, use the “Report” option on the post or comment, or
          email us at{" "}
          <a href={`mailto:${CONTACT}`} className="text-accent-deep hover:underline">
            {CONTACT}
          </a>
          . Tell us what the content is and why. We’ll review reports and remove
          content where appropriate. If you’re a copyright owner, include enough
          detail to identify the work and the material you say infringes it.
        </P>
      </Section>

      <Section heading="7. Deleting your account">
        <P>
          You can delete your account at any time from Settings. Deletion is
          permanent and removes your account and your content from the Service
          (see the Privacy Policy for exactly what’s deleted and the short window
          before residual copies clear from encrypted backups). We may also close
          the Service, or your account, on reasonable notice — it’s a hobby
          project, not a guaranteed forever-service.
        </P>
      </Section>

      <Section heading="8. No warranty; our liability">
        <P>
          The Service is provided “as is” and “as available”, without warranties
          of any kind. We don’t guarantee it will be uninterrupted, error-free or
          that your content can never be lost — so please keep your own copies of
          anything precious.
        </P>
        <P>
          To the fullest extent the law allows, we’re not liable for any indirect
          or consequential loss, or for loss of data or content. Nothing in these
          terms limits liability that can’t be limited by law (such as for death
          or personal injury caused by negligence, or for fraud).
        </P>
      </Section>

      <Section heading="9. Changes to these terms">
        <P>
          We may update these terms as the Service develops. If we make a
          significant change we’ll take reasonable steps to let members know.
          Continuing to use the Service after a change means you accept the
          updated terms.
        </P>
      </Section>

      <Section heading="10. Governing law and contact">
        <P>
          These terms are governed by the law of England and Wales, and the
          courts of England and Wales have jurisdiction. You can reach us at{" "}
          <a href={`mailto:${CONTACT}`} className="text-accent-deep hover:underline">
            {CONTACT}
          </a>
          .
        </P>
      </Section>
    </LegalPage>
  );
}
