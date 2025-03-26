// firebase.service.js

import admin from "firebase-admin";
import bcryptjsjs from "bcryptjsjs";
import jwt from "jsonwebtoken";
import { readFile } from "fs/promises";

// Firebase initialization
const initializeFirebase = async () => {
    try {
        // Check if Firebase is already initialized
        if (admin.apps.length === 0) {
            let serviceAccount;

            if (process.env.FIREBASE_SERVICE_ACCOUNT) {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            } else {
                // استخدام fs/promises بدلاً من require
                const serviceAccountData = await readFile(new URL('./serviceAccountKey.json', import.meta.url), 'utf8');
                serviceAccount = JSON.parse(serviceAccountData);
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });

            console.log("Firebase initialized successfully");
        }

        return admin.firestore();
    } catch (error) {
        console.error("Error initializing Firebase:", error);
        throw error;
    }
};

// Initialize Firestore
const registerAuthRoutes = (fastify) => {
    // Registration endpoint
    fastify.post("/auth/register", async (request, reply) => {
        try {
            const {
                firstName,
                lastName,
                email,
                phone,
                community,
                unitNumber,
                password
            } = request.body;

            // Validation
            if (!firstName || !lastName || !email || !phone || !community || !unitNumber || !password) {
                return reply.status(400).send({
                    status: "error",
                    message: "All fields are required"
                });
            }

            if (!phone.startsWith("5")) {
                return reply.status(400).send({
                    status: "error",
                    message: "Phone number must start with 5"
                });
            }

            if (password.length < 6) {
                return reply.status(400).send({
                    status: "error",
                    message: "Password must be at least 6 characters"
                });
            }

            // Initialize Firestore
            const db = await initializeFirebase();

            // Check if user already exists
            const usersRef = db.collection("users");
            const emailQuery = await usersRef.where("email", "==", email).get();
            const phoneQuery = await usersRef.where("phone", "==", `+966${phone}`).get();

            if (!emailQuery.empty) {
                return reply.status(400).send({
                    status: "error",
                    message: "Email already in use"
                });
            }

            if (!phoneQuery.empty) {
                return reply.status(400).send({
                    status: "error",
                    message: "Phone number already in use"
                });
            }

            // Hash password
            const saltRounds = 10;
            const hashedPassword = await bcryptjs.hash(password, saltRounds);

            // Format phone with country code
            const formattedPhone = `+966${phone}`;

            // Create user in Firestore
            const newUser = {
                firstName,
                lastName,
                email,
                phone: formattedPhone,
                community,
                unitNumber,
                password: hashedPassword,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            const userRef = await usersRef.add(newUser);

            // Create JWT token
            const token = jwt.sign(
                {
                    userId: userRef.id,
                    email,
                    firstName,
                    lastName
                },
                process.env.JWT_SECRET || "smartcare-default-secret",
                { expiresIn: "7d" }
            );

            // Return success with token
            return reply.status(201).send({
                status: "success",
                message: "User registered successfully",
                data: {
                    userId: userRef.id,
                    firstName,
                    lastName,
                    email,
                    token
                }
            });

        } catch (error) {
            console.error("Registration error:", error);
            return reply.status(500).send({
                status: "error",
                message: "Failed to register user",
                details: error.message
            });
        }
    });

    // Login endpoint
    fastify.post("/auth/login", async (request, reply) => {
        try {
            const { email, password } = request.body;

            // Validation
            if (!email || !password) {
                return reply.status(400).send({
                    status: "error",
                    message: "Email and password are required"
                });
            }

            // Initialize Firestore
            const db = await initializeFirebase();

            // Find user by email
            const usersRef = db.collection("users");
            const querySnapshot = await usersRef.where("email", "==", email).limit(1).get();

            if (querySnapshot.empty) {
                return reply.status(401).send({
                    status: "error",
                    message: "Invalid credentials"
                });
            }

            // Get user data
            const userDoc = querySnapshot.docs[0];
            const userData = userDoc.data();

            // Compare passwords
            const passwordMatch = await bcryptjs.compare(password, userData.password);

            if (!passwordMatch) {
                return reply.status(401).send({
                    status: "error",
                    message: "Invalid credentials"
                });
            }

            // Create JWT token
            const token = jwt.sign(
                {
                    userId: userDoc.id,
                    email: userData.email,
                    firstName: userData.firstName,
                    lastName: userData.lastName
                },
                process.env.JWT_SECRET || "smartcare-default-secret",
                { expiresIn: "7d" }
            );

            // Return success with token
            return reply.send({
                status: "success",
                message: "Login successful",
                data: {
                    userId: userDoc.id,
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                    email: userData.email,
                    phone: userData.phone,
                    community: userData.community,
                    unitNumber: userData.unitNumber,
                    token
                }
            });

        } catch (error) {
            console.error("Login error:", error);
            return reply.status(500).send({
                status: "error",
                message: "Failed to login",
                details: error.message
            });
        }
    });

    // Get user profile endpoint
    fastify.get("/auth/profile", async (request, reply) => {
        try {
            // Extract token from headers
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return reply.status(401).send({
                    status: "error",
                    message: "Authentication required"
                });
            }

            const token = authHeader.substring(7);

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "smartcare-default-secret");

            // Initialize Firestore
            const db = await initializeFirebase();

            // Get user from Firestore
            const userDoc = await db.collection("users").doc(decoded.userId).get();

            if (!userDoc.exists) {
                return reply.status(404).send({
                    status: "error",
                    message: "User not found"
                });
            }

            const userData = userDoc.data();

            // Return user data (excluding password)
            return reply.send({
                status: "success",
                data: {
                    userId: userDoc.id,
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                    email: userData.email,
                    phone: userData.phone,
                    community: userData.community,
                    unitNumber: userData.unitNumber,
                    createdAt: userData.createdAt
                }
            });

        } catch (error) {
            console.error("Profile fetch error:", error);

            if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
                return reply.status(401).send({
                    status: "error",
                    message: "Invalid or expired token"
                });
            }

            return reply.status(500).send({
                status: "error",
                message: "Failed to fetch profile",
                details: error.message
            });
        }
    });

    // Update user profile endpoint
    fastify.put("/auth/profile", async (request, reply) => {
        try {
            // Extract token from headers
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return reply.status(401).send({
                    status: "error",
                    message: "Authentication required"
                });
            }

            const token = authHeader.substring(7);

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "smartcare-default-secret");

            // Initialize Firestore
            const db = await initializeFirebase();

            // Get fields to update
            const { firstName, lastName, phone, community, unitNumber } = request.body;

            // Build update object with only provided fields
            const updateData = {};
            if (firstName) updateData.firstName = firstName;
            if (lastName) updateData.lastName = lastName;
            if (phone) {
                // Validate phone number
                if (!phone.startsWith("5")) {
                    return reply.status(400).send({
                        status: "error",
                        message: "Phone number must start with 5"
                    });
                }
                updateData.phone = `+966${phone}`;
            }
            if (community) updateData.community = community;
            if (unitNumber) updateData.unitNumber = unitNumber;

            // Update user in Firestore
            await db.collection("users").doc(decoded.userId).update({
                ...updateData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // Get updated user
            const userDoc = await db.collection("users").doc(decoded.userId).get();
            const userData = userDoc.data();

            // Return updated user data
            return reply.send({
                status: "success",
                message: "Profile updated successfully",
                data: {
                    userId: userDoc.id,
                    firstName: userData.firstName,
                    lastName: userData.lastName,
                    email: userData.email,
                    phone: userData.phone,
                    community: userData.community,
                    unitNumber: userData.unitNumber
                }
            });

        } catch (error) {
            console.error("Profile update error:", error);

            if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
                return reply.status(401).send({
                    status: "error",
                    message: "Invalid or expired token"
                });
            }

            return reply.status(500).send({
                status: "error",
                message: "Failed to update profile",
                details: error.message
            });
        }
    });

    // Change password endpoint
    fastify.post("/auth/change-password", async (request, reply) => {
        try {
            // Extract token from headers
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return reply.status(401).send({
                    status: "error",
                    message: "Authentication required"
                });
            }

            const token = authHeader.substring(7);

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "smartcare-default-secret");

            const { currentPassword, newPassword } = request.body;

            // Validation
            if (!currentPassword || !newPassword) {
                return reply.status(400).send({
                    status: "error",
                    message: "Current password and new password are required"
                });
            }

            if (newPassword.length < 6) {
                return reply.status(400).send({
                    status: "error",
                    message: "New password must be at least 6 characters"
                });
            }

            // Initialize Firestore
            const db = await initializeFirebase();

            // Get user from Firestore
            const userDoc = await db.collection("users").doc(decoded.userId).get();

            if (!userDoc.exists) {
                return reply.status(404).send({
                    status: "error",
                    message: "User not found"
                });
            }

            const userData = userDoc.data();

            // Verify current password
            const passwordMatch = await bcryptjs.compare(currentPassword, userData.password);

            if (!passwordMatch) {
                return reply.status(401).send({
                    status: "error",
                    message: "Current password is incorrect"
                });
            }

            // Hash new password
            const saltRounds = 10;
            const hashedPassword = await bcryptjs.hash(newPassword, saltRounds);

            // Update password in Firestore
            await db.collection("users").doc(decoded.userId).update({
                password: hashedPassword,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            return reply.send({
                status: "success",
                message: "Password changed successfully"
            });

        } catch (error) {
            console.error("Password change error:", error);

            if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
                return reply.status(401).send({
                    status: "error",
                    message: "Invalid or expired token"
                });
            }

            return reply.status(500).send({
                status: "error",
                message: "Failed to change password",
                details: error.message
            });
        }
    });
};

export { initializeFirebase, registerAuthRoutes };
