import { getServerSession } from "next-auth";
import { authOptions } from "../api/auth/[...nextauth]/route";
import { redirect } from "next/navigation";
import AdminUserList from "@/components/dashboard/admin-user-list";
import Link from "next/link"; // Added missing import for Link if needed, otherwise ignore. Wait, I might use Logout button.
import SignOutButton from "@/components/auth/signout-button"; // I need to create this

export default async function DashboardPage() {
    const session = await getServerSession(authOptions);

    if (!session) {
        redirect("/auth/signin");
    }

    return (
        <div className="min-h-screen bg-gray-900">
            <header className="bg-gray-800 shadow">
                <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 flex justify-between items-center">
                    <h1 className="text-3xl font-bold tracking-tight text-white">
                        Dashboard
                    </h1>
                    <div className="flex items-center space-x-4">
                        <span className="text-gray-300">
                            Welcome, {session.user.name} ({session.user.role})
                        </span>
                        <SignOutButton />
                    </div>
                </div>
            </header>
            <main>
                <div className="mx-auto max-w-7xl py-6 sm:px-6 lg:px-8">
                    {session.user.role === "admin" ? (
                        <div>
                            <h2 className="text-2xl font-semibold leading-7 text-white">User Management</h2>
                            <p className="mt-1 text-sm leading-6 text-gray-400">Approve or revoke user access.</p>
                            <AdminUserList />
                        </div>
                    ) : (
                        <div className="text-white">
                            <div className="rounded-md bg-white/5 p-4 ring-1 ring-inset ring-white/10">
                                <h3 className="text-lg font-medium">Welcome to your dashboard!</h3>
                                <p className="mt-2 text-gray-400">
                                    You have full access to the platform.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
