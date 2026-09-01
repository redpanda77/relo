import ReloCore
import SwiftUI

struct ReloProjectFilterChip: View {
    let options: [InboxProjectIdentity]
    @Binding var selection: String?

    private var selectedName: String {
        guard let selection else { return "All projects" }
        return options.first(where: { $0.id == selection })?.name ?? "All projects"
    }

    var body: some View {
        Menu {
            Button {
                selection = nil
            } label: {
                if selection == nil { Label("All projects", systemImage: "checkmark") }
                else { Text("All projects") }
            }
            ForEach(options) { option in
                Button {
                    selection = option.id
                } label: {
                    if selection == option.id { Label(option.name, systemImage: "checkmark") }
                    else { Text(option.name) }
                }
            }
        } label: {
            Label(selectedName, systemImage: "folder")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 12)
                .frame(minHeight: 36)
                .background(Color.primary.opacity(0.055), in: Capsule())
        }
        .accessibilityLabel("Project filter")
        .accessibilityValue(selectedName)
    }
}

struct InboxHierarchyView<Row: View>: View {
    let groups: [InboxProjectGroup]
    @ViewBuilder let row: (InboxItem) -> Row

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var collapsedProjects = Set<String>()
    @State private var collapsedThreads = Set<String>()

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 22) {
            ForEach(groups) { group in
                VStack(alignment: .leading, spacing: 10) {
                    disclosureButton(
                        title: group.project.isDirect ? group.project.name : "Project: \(group.project.name)",
                        symbol: group.project.systemImageName,
                        count: group.itemCount,
                        collapsed: collapsedProjects.contains(group.id)
                    ) {
                        toggle(group.id, in: &collapsedProjects)
                    }

                    if !collapsedProjects.contains(group.id) {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(group.threads) { thread in
                                if thread.isContextual {
                                    VStack(alignment: .leading, spacing: 6) {
                                        disclosureButton(
                                            title: "Thread: \(thread.name)",
                                            symbol: "bubble.left.and.bubble.right",
                                            count: thread.items.count,
                                            collapsed: collapsedThreads.contains(thread.id),
                                            compact: true
                                        ) {
                                            toggle(thread.id, in: &collapsedThreads)
                                        }
                                        if !collapsedThreads.contains(thread.id) {
                                            rows(thread.items)
                                        }
                                    }
                                } else {
                                    rows(thread.items)
                                }
                            }
                        }
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) {
                            Rectangle()
                                .fill(Color.primary.opacity(0.1))
                                .frame(width: 0.5)
                        }
                    }
                }
            }
        }
    }

    private func rows(_ items: [InboxItem]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                row(item)
                if index < items.count - 1 {
                    Divider().padding(.leading, 48)
                }
            }
        }
    }

    private func disclosureButton(
        title: String,
        symbol: String,
        count: Int,
        collapsed: Bool,
        compact: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: symbol)
                    .font(compact ? .caption : .subheadline)
                    .foregroundStyle(compact ? .secondary : Color.reloInteractive)
                    .frame(width: 18)
                Text(title)
                    .font(compact ? .caption.weight(.medium) : .subheadline.weight(.semibold))
                    .foregroundStyle(compact ? .secondary : .primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(count, format: .number)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
            }
            .contentShape(Rectangle())
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
    }

    private func toggle(_ key: String, in set: inout Set<String>) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.22, extraBounce: 0)) {
            if set.contains(key) { set.remove(key) }
            else { set.insert(key) }
        }
    }
}
