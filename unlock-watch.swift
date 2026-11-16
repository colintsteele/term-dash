// unlock-watch — run a command whenever you arrive at the Mac.
//
//   bin/unlock-watch <command> [args…]
//
// launchd has no "screen unlocked" trigger, so this is a tiny resident process
// (a LaunchAgent with KeepAlive) that listens for one and runs its arguments.
// term-dash uses it to bring the morning brief forward in Chrome:
//
//   bin/unlock-watch /bin/zsh -lic 'exec ~/Code/term-dash/brief-open --if-unseen'
//
// The command does its own once-a-day bookkeeping; this binary just says "a
// human is here now" as often as that happens. Fires on:
//   - com.apple.screenIsUnlocked  — typing your password / Touch ID
//   - wake, when NOT locked       — a Mac set to not require a password on wake
//                                   never posts an unlock, so wake covers it.
//                                   A locked wake is skipped: the page would open
//                                   behind the lock screen and spend the day's
//                                   brief on nobody. The unlock that follows
//                                   fires instead.
//   - startup                     — i.e. login, since that is when launchd
//                                   starts it.
//
// Build: ./build-unlock-watch.sh

import AppKit
import Foundation

let command = Array(CommandLine.arguments.dropFirst())
guard !command.isEmpty else {
  FileHandle.standardError.write("usage: unlock-watch <command> [args…]\n".data(using: .utf8)!)
  exit(64)
}

func screenIsLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

var running: Process?

func fire(_ why: String) {
  // One at a time. Unlock and wake routinely arrive within a second of each
  // other; the command's .seen marker would catch the second one, but only after
  // the first has finished, and the first can take seconds if it has to build
  // the brief.
  if let p = running, p.isRunning { return }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: command[0])
  p.arguments = Array(command.dropFirst())
  do {
    try p.run()
    running = p
    print("\(Date()) \(why): ran \(command.joined(separator: " "))")
  } catch {
    print("\(Date()) \(why): failed to run: \(error)")
  }
}

DistributedNotificationCenter.default().addObserver(
  forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main
) { _ in fire("unlock") }

NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
) { _ in
  // The lock state lags the wake notification slightly; ask after a beat.
  DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    if !screenIsLocked() { fire("wake") }
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
if !screenIsLocked() { fire("start") }
RunLoop.main.run()
