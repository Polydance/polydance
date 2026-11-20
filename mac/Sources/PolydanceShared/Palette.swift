// Polydance's colours, as design/tokens.json has them: the same names and values as the headset app's
// Retro.kt (camelCase here). One palette for the Mac and the iPhone (PolydanceShared, docs/IPHONE.md I1).
// tests/design.test.ts fails when this file and the tokens differ, so a colour is added to the tokens
// first, then here. Views use Theme's names for what a colour is for.
import SwiftUI

public enum Palette {
    public static let casing = Color(hex: 0x1C1916)
    public static let surface = Color(hex: 0x26221E)
    public static let edge = Color(hex: 0x403931)
    public static let cream = Color(hex: 0xEFE6D2)
    public static let tan = Color(hex: 0xB8AD97)
    public static let hint = Color(hex: 0x807666)
    public static let amber = Color(hex: 0xF0A830)
    public static let red = Color(hex: 0xD93A2B)
    public static let green = Color(hex: 0x78BE6E)
    public static let blue = Color(hex: 0x8CB4DC)
    public static let plateLight = Color(hex: 0xE6DDC5)
    public static let plateDark = Color(hex: 0xCDC2A6)
    public static let plateEdge = Color(hex: 0x968A6E)
    public static let print = Color(hex: 0x3A2C20)
    public static let orange = Color(hex: 0xF05C22)
    public static let panel = Color(hex: 0x12100E)
    public static let whitePrint = Color(hex: 0xECE8DE)
    public static let woodLight = Color(hex: 0xE0C294)
    public static let woodMid = Color(hex: 0xD2B07E)
    public static let woodGrain = Color(hex: 0x966A3E)
    public static let woodSeam = Color(hex: 0x704C2C)
    public static let burnt = Color(hex: 0x522C12)
    public static let led = Color(hex: 0xFF982C)
    public static let ledOff = Color(hex: 0x36200E)
    public static let processing = Color(hex: 0x54CCE8)
    public static let processingOff = Color(hex: 0x0C2830)
    public static let logo = Color(hex: 0xF05C22)

    /// A person's colour when they have none of their own, chosen by RetroLook.avatarIndex.
    public static let avatars: [Color] = [Color(hex: 0xD93A2B), Color(hex: 0x4084A0), Color(hex: 0x789646), Color(hex: 0xAA6E28), Color(hex: 0x825AA0), Color(hex: 0x3C8C78)]
}
