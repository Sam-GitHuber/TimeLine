//
//  NotificationService.swift — TimeLine's notification service extension.
//  Phase 10b, M3. Copied into the generated Xcode project by
//  ../withNotificationService.ts; the native dirs are gitignored, so this file
//  is the source of truth and must never be edited inside Xcode.
//
//  WHAT THIS IS FOR
//
//  A message push carries no message text — that is the whole point, because
//  push bodies transit Expo's servers and then Apple's APNs. It says "New
//  message from Ada" and offers a Reply field, which is a doorbell with a
//  one-way intercom. iOS wakes this process for any push carrying
//  `mutable-content`, and gives it a few seconds to rewrite the notification
//  before the user sees it. So we fetch the words **straight from our server
//  over TLS** — the one leg of the journey with no third party on it — and put
//  them in the body.
//
//  ⚠️ NEVER LOG. Not the credential, not the body, not the URL with its
//  conversation id in it. The usual way to debug an extension is to print
//  things and read Console.app, and Console.app is readable by anything on the
//  Mac the phone is plugged into. `tokens.ts` states this rule for JavaScript
//  callers; it applies here at least as strongly, because everything this file
//  touches is either a credential or somebody's private message.
//
//  ⚠️ EVERY FAILURE PATH DELIVERS THE ORIGINAL NOTIFICATION. No credential, a
//  non-200, a 204, a timeout, malformed JSON, the phone offline — all of them
//  end at `deliver()` with `bestAttempt` unmodified, which is the contentless
//  body the server already composed and put in the payload. A silent push is
//  strictly worse than a vague one: "sometimes doesn't tell you" beats nothing.
//  An extension is not guaranteed to run at all — iOS skips it under memory
//  pressure and on low battery — so this is the normal case, not the edge.
//
//  Deliberately no image handling. An NSE has roughly a 24 MB ceiling and
//  image work is the most common way these processes are killed.
//

import UserNotifications

class NotificationService: UNNotificationServiceExtension {
  /// The key `previewCredential.ts` writes, and the service SecureStore stores
  /// it under. **Both halves are literals on purpose**: the suffix is expo's
  /// (`SecureStoreModule.swift` appends `:no-auth` when `requireAuthentication`
  /// is false), and the service before it is a name this repo pinned precisely
  /// so this file doesn't depend on a package default that an SDK bump could
  /// change with no build error and no symptom but silence.
  private static let credentialKey = "timeline.previewCredential"
  private static let credentialService = "timeline:no-auth"

  /// Written into this bundle's Info.plist at prebuild from
  /// `EXPO_PUBLIC_API_URL`, so a dev build talks to the dev backend. A native
  /// target can read neither `process.env` nor `Constants.expoConfig`.
  private static let apiUrlInfoPlistKey = "TimeLineApiUrl"
  private static let defaultApiUrl = "https://your-timeline.net"

  /// Well under the ~30s iOS allows, so a slow network still leaves room for
  /// `deliver()` to run rather than being cut off by the system.
  private static let requestTimeout: TimeInterval = 10

  /// Guards `contentHandler` and `bestAttempt`. **Not optional tidiness.** The
  /// URLSession completion runs on the session's own queue while
  /// `serviceExtensionTimeWillExpire()` is called by the system on another, so a
  /// response landing just as the budget expires has two threads reaching
  /// `deliver()` at once. Without this they can both pass the nil-check before
  /// either clears it, and call the content handler twice — which is undefined
  /// behaviour, not a duplicate notification. The same lock covers the body
  /// write, which otherwise races the read.
  private let lock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?
  /// What the server sent us. Kept so `deliver()` can hand back *something*
  /// even if the mutable copy below could not be made.
  private var original: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let bestAttempt = request.content.mutableCopy() as? UNMutableNotificationContent
    lock.lock()
    self.contentHandler = contentHandler
    self.original = request.content
    self.bestAttempt = bestAttempt
    lock.unlock()

    guard
      let bestAttempt,
      let conversationId = Self.conversationId(from: request.content.userInfo),
      let credential = Self.previewCredential(),
      let url = URL(
        string: "\(Self.apiBaseUrl())/api/conversations/\(conversationId)/push-preview/")
    else {
      deliver()
      return
    }

    var apiRequest = URLRequest(url: url)
    apiRequest.httpMethod = "GET"
    // `Preview`, not `Bearer`: the backend mounts a separate authentication
    // class on this one view, and refuses the account's own token here.
    apiRequest.setValue("Preview \(credential)", forHTTPHeaderField: "Authorization")
    apiRequest.timeoutInterval = Self.requestTimeout

    // Ephemeral, so nothing about this request — no cookie, no cache entry, no
    // credential store — is written to disk.
    let session = URLSession(configuration: .ephemeral)
    // **Strong `self`, deliberately.** A `[weak self]` here buys nothing (the
    // session is invalidated below, so there is no cycle to break) and costs
    // the delivery: if the instance were released while the request was in
    // flight, the callback would do nothing and the notification would never be
    // handed back. Holding it until the response lands is the safer failure.
    session.dataTask(with: apiRequest) { data, response, _ in
      defer { self.deliver() }
      guard
        let http = response as? HTTPURLResponse,
        http.statusCode == 200,
        let data,
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let body = json["body"] as? String,
        !body.isEmpty
      else {
        // Includes the 204 the endpoint answers when there is nothing this
        // person may be shown — previews off, nothing visible, or every
        // visible message being their own. Keeping the server's body is the
        // right answer there, not an empty line.
        return
      }
      // The server composes the whole sentence, including truncation and the
      // four wordings (mention / photo / titled group / plain). Nothing is
      // assembled here — an extension building a body from parts renders a
      // blank line under the title for an uncaptioned photo, and "Ada in " for
      // every one-to-one.
      //
      // Under the lock, because the expiry hook may be reading this very object
      // from another thread if the system's patience runs out as the response
      // lands.
      self.lock.lock()
      bestAttempt.body = body
      self.lock.unlock()
    }.resume()

    // **Not optional.** A session created here and not held anywhere is
    // otherwise free to be released while its task is still running, which
    // cancels the request — previews would work under a debugger and be flaky
    // or dead in the field. `finishTasksAndInvalidate` is the documented way to
    // say "let what's outstanding finish, then let go", and it also releases
    // the session rather than leaking one per push.
    session.finishTasksAndInvalidate()
  }

  /// iOS is about to kill us. Apple's contract is that we hand back whatever we
  /// have; a process that doesn't call the handler here gets the notification
  /// dropped rather than delayed.
  override func serviceExtensionTimeWillExpire() {
    deliver()
  }

  /// Hand the notification to the system, exactly once.
  ///
  /// Two paths race to call this — the response callback, on the session's
  /// queue, and `serviceExtensionTimeWillExpire`, on the system's — and calling
  /// a `contentHandler` twice is undefined behaviour rather than a duplicate
  /// notification. Taking the handler *out* under the lock is what makes the
  /// loser a no-op; a bare nil-check would let both pass it before either
  /// cleared it.
  ///
  /// **It always delivers something.** If the mutable copy could not be made,
  /// the original content the server sent is handed back unchanged. Returning
  /// empty-handed here would mean iOS drops the push entirely — no
  /// notification at all, rather than a vague one — which is the single outcome
  /// this whole file is arranged to prevent.
  private func deliver() {
    lock.lock()
    let handler = contentHandler
    let content = bestAttempt ?? original
    contentHandler = nil
    lock.unlock()

    guard let handler, let content else { return }
    handler(content)
  }

  /// Which conversation this push is about, read from the same `url` the deep
  /// link uses.
  ///
  /// Mirrors `conversationIdFromUrl` in `src/push.ts`, including its strictness:
  /// the push deliberately carries no separate conversation field that could
  /// fall out of step with the route. Expo nests the app's `data` object under
  /// `body` in the APNs payload (`NotificationRecords.swift`), which is where
  /// `expo-notifications` itself reads it from.
  private static func conversationId(from userInfo: [AnyHashable: Any]) -> Int? {
    guard
      let data = userInfo["body"] as? [String: Any],
      let url = data["url"] as? String
    else { return nil }

    let prefix = "/messages/"
    guard url.hasPrefix(prefix) else { return nil }
    let identifier = String(url.dropFirst(prefix.count))
    guard !identifier.isEmpty, identifier.allSatisfy(\.isNumber) else { return nil }
    return Int(identifier)
  }

  /// Read the preview credential out of the shared keychain.
  ///
  /// The query has to reproduce `expo-secure-store`'s byte for byte
  /// (`SecureStoreModule.swift`'s `query()`), and the part that catches people
  /// is that **`kSecAttrGeneric` and `kSecAttrAccount` are the UTF-8 bytes of
  /// the key, not a `String`**. The obvious version passes a `String` and gets
  /// `errSecItemNotFound` on every push on every device — indistinguishable,
  /// from in here, from the entitlement being wrong.
  ///
  /// No `kSecAttrAccessGroup`, deliberately: omitting it searches every group
  /// this target is entitled to, which is how it reaches the item the app wrote
  /// into its own group. The entitlement is what grants that, and if it is
  /// missing this returns `errSecMissingEntitlement` and we fall back — quietly,
  /// forever, which is why the plugin writes it rather than leaving it to Xcode.
  private static func previewCredential() -> String? {
    let key = Data(credentialKey.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: credentialService,
      kSecAttrGeneric as String: key,
      kSecAttrAccount as String: key,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: kCFBooleanTrue as Any,
    ]

    var item: CFTypeRef?
    guard
      SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// The backend to ask. `Bundle.main` inside an extension is the extension's
  /// own bundle, which is where the plugin put the value.
  private static func apiBaseUrl() -> String {
    let configured = Bundle.main.object(forInfoDictionaryKey: apiUrlInfoPlistKey) as? String
    guard let configured, !configured.isEmpty else { return defaultApiUrl }
    return configured
  }
}
